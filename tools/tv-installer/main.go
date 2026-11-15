// Установщик Perfect TV на телевизор LG webOS с компьютера (Windows, Linux, macOS).
//
// На телевизоре — приложение «Developer Mode» (LG Content Store): режим разработчика включён,
// «Key Server» включён. Программа берёт у телевизора ключ SSH (http://IP:9991/webos_rsa,
// зашифрован кодом Passphrase из Developer Mode), заходит по SSH (prisoner@IP:9922), копирует
// .ipk в /media/developer/temp, ставит его через com.webos.appInstallService/dev/install,
// запускает приложение и продлевает сессию режима разработчика.
//
// Пакет: файл, перетащенный на программу, или самый свежий *.ipk рядом с ней.
// Последние IP и код запоминаются в tv-installer.json рядом с программой.
// Для проверки на эмуляторе: PTV_SSH_PORT, PTV_SSH_USER, PTV_KEY_FILE (готовый ключ вместо 9991).
package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

type settings struct {
	IP         string `json:"ip"`
	Passphrase string `json:"passphrase"`
}

var in = bufio.NewReader(os.Stdin)

func main() {
	consoleUTF8()
	fmt.Println("Perfect TV — установка на телевизор LG (webOS)")
	fmt.Println("──────────────────────────────────────────────")
	err := run()
	if err != nil {
		fmt.Println()
		fmt.Println("✗ " + err.Error())
	}
	fmt.Println()
	fmt.Print("Нажмите Enter, чтобы закрыть окно…")
	in.ReadString('\n')
	if err != nil {
		os.Exit(1)
	}
}

func exeDir() string {
	p, err := os.Executable()
	if err != nil {
		return "."
	}
	return filepath.Dir(p)
}

func run() error {
	ipk, err := findIpk()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(ipk)
	if err != nil {
		return fmt.Errorf("не удалось прочитать %s: %v", ipk, err)
	}
	appID, version := ipkInfo(data)
	if appID == "" {
		return fmt.Errorf("%s — не похоже на пакет webOS (.ipk)", filepath.Base(ipk))
	}
	fmt.Printf("Пакет: %s (%s %s, %.1f МБ)\n\n", filepath.Base(ipk), appID, version, float64(len(data))/1048576)

	cfgPath := filepath.Join(exeDir(), "tv-installer.json")
	var cfg settings
	if b, e := os.ReadFile(cfgPath); e == nil {
		json.Unmarshal(b, &cfg)
	}
	fmt.Println("На телевизоре откройте приложение «Developer Mode»: режим разработчика и Key Server —")
	fmt.Println("включены. IP и код (Passphrase) показаны там же.")
	fmt.Println()
	cfg.IP = ask("IP-адрес телевизора", cfg.IP)
	if net.ParseIP(cfg.IP) == nil && !regexp.MustCompile(`^[\w.-]+$`).MatchString(cfg.IP) {
		return fmt.Errorf("«%s» — не IP-адрес", cfg.IP)
	}
	cfg.Passphrase = strings.ToUpper(ask("Код (Passphrase) из Developer Mode", cfg.Passphrase))
	if b, e := json.MarshalIndent(cfg, "", "  "); e == nil {
		os.WriteFile(cfgPath, b, 0600)
	}
	fmt.Println()

	step("Получаю ключ доступа с телевизора")
	signer, err := getKey(cfg.IP, cfg.Passphrase)
	if err != nil {
		return err
	}
	ok()

	step("Подключаюсь к телевизору")
	client, err := connect(cfg.IP, signer)
	if err != nil {
		return err
	}
	defer client.Close()
	ok()

	remote := "/media/developer/temp/" + sanitize(filepath.Base(ipk))
	step(fmt.Sprintf("Копирую пакет (%.1f МБ)", float64(len(data))/1048576))
	if _, err := runCmd(client, "mkdir -p /media/developer/temp && chmod 777 /media/developer/temp", nil); err != nil {
		return fmt.Errorf("не удалось подготовить папку на телевизоре: %v", err)
	}
	if _, err := runCmd(client, "cat > '"+remote+"'", bytes.NewReader(data)); err != nil {
		return fmt.Errorf("не удалось скопировать пакет: %v", err)
	}
	ok()

	step("Устанавливаю")
	err = install(client, appID, remote)
	runCmd(client, "rm -f '"+remote+"'", nil)
	if err != nil {
		return err
	}
	ok()

	step("Запускаю " + appID)
	out, err := lunaOnce(client, "luna://com.webos.applicationManager/launch", map[string]interface{}{"id": appID, "subscribe": false, "params": map[string]interface{}{}})
	if err != nil || !strings.Contains(out, `"returnValue":true`) {
		fmt.Println(" — не вышло (запустите с телевизора)")
	} else {
		ok()
	}

	step("Продлеваю режим разработчика")
	if msg, e := extendDevMode(client); e != nil {
		fmt.Println(" — не вышло: " + e.Error())
	} else {
		fmt.Println(" ✓ " + msg)
	}

	fmt.Println()
	fmt.Println("Готово: Perfect TV установлен.")
	fmt.Println("Режим разработчика действует ограниченное время (около 50 часов): запускайте эту программу")
	fmt.Println("время от времени — она продлевает его, иначе телевизор удалит установленные приложения.")
	return nil
}

func step(s string) { fmt.Print("• " + s + "…") }
func ok()           { fmt.Println(" ✓") }

func ask(prompt, def string) string {
	for {
		if def != "" {
			fmt.Printf("%s [%s]: ", prompt, def)
		} else {
			fmt.Printf("%s: ", prompt)
		}
		line, _ := in.ReadString('\n')
		line = strings.TrimSpace(line)
		if line == "" {
			line = def
		}
		if line != "" {
			return line
		}
	}
}

func sanitize(s string) string {
	return regexp.MustCompile(`[^\w.-]`).ReplaceAllString(s, "_")
}

// Пакет: перетащенный на программу файл, иначе самый свежий *.ipk рядом с ней или в текущей папке
func findIpk() (string, error) {
	for _, a := range os.Args[1:] {
		if strings.HasSuffix(strings.ToLower(a), ".ipk") {
			return a, nil
		}
	}
	var found []string
	for _, dir := range []string{exeDir(), "."} {
		m, _ := filepath.Glob(filepath.Join(dir, "*.ipk"))
		found = append(found, m...)
	}
	if len(found) == 0 {
		fmt.Println("Рядом с программой нет файла .ipk.")
		p := strings.Trim(ask("Путь к файлу .ipk (можно перетащить файл в это окно)", ""), `"' `)
		return p, nil
	}
	sort.Slice(found, func(i, j int) bool {
		a, _ := os.Stat(found[i])
		b, _ := os.Stat(found[j])
		return a.ModTime().After(b.ModTime())
	})
	return found[0], nil
}

// id и версия из control внутри .ipk (ar: debian-binary, control.tar.gz, data.tar.gz)
func ipkInfo(data []byte) (string, string) {
	if !bytes.HasPrefix(data, []byte("!<arch>\n")) {
		return "", ""
	}
	p := 8
	for p+60 <= len(data) {
		name := strings.TrimRight(strings.TrimSpace(string(data[p:p+16])), "/")
		var size int
		fmt.Sscanf(strings.TrimSpace(string(data[p+48:p+58])), "%d", &size)
		body := data[p+60 : min(len(data), p+60+size)]
		if strings.HasPrefix(name, "control.tar") {
			gz, err := gzip.NewReader(bytes.NewReader(body))
			if err != nil {
				return "", ""
			}
			tr := tar.NewReader(gz)
			for {
				h, err := tr.Next()
				if err != nil {
					return "", ""
				}
				if filepath.Base(h.Name) == "control" {
					b, _ := io.ReadAll(tr)
					id := regexp.MustCompile(`(?m)^Package:\s*(\S+)`).FindSubmatch(b)
					ver := regexp.MustCompile(`(?m)^Version:\s*(\S+)`).FindSubmatch(b)
					if id == nil {
						return "", ""
					}
					v := ""
					if ver != nil {
						v = string(ver[1])
					}
					return string(id[1]), v
				}
			}
		}
		p += 60 + size + size%2
	}
	return "", ""
}

func getKey(ip, pass string) (ssh.Signer, error) {
	var pem []byte
	if f := os.Getenv("PTV_KEY_FILE"); f != "" {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		pem = b
	} else {
		c := http.Client{Timeout: 8 * time.Second}
		resp, err := c.Get("http://" + ip + ":9991/webos_rsa")
		if err != nil {
			return nil, errors.New("телевизор не отвечает. Проверьте IP, что компьютер и ТВ в одной сети, " +
				"приложение Developer Mode открыто, а «Key Server» в нём включён")
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("телевизор не отдал ключ (HTTP %d) — включите «Key Server» в Developer Mode", resp.StatusCode)
		}
		pem, _ = io.ReadAll(resp.Body)
	}
	if s, err := ssh.ParsePrivateKey(pem); err == nil {
		return s, nil
	}
	s, err := ssh.ParsePrivateKeyWithPassphrase(pem, []byte(pass))
	if err != nil {
		return nil, errors.New("неверный код (Passphrase): посмотрите его в приложении Developer Mode")
	}
	return s, nil
}

func connect(ip string, signer ssh.Signer) (*ssh.Client, error) {
	port, user := os.Getenv("PTV_SSH_PORT"), os.Getenv("PTV_SSH_USER")
	if port == "" {
		port = "9922"
	}
	if user == "" {
		user = "prisoner"
	}
	conf := &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // ключ хоста ТВ меняется при сбросе — не проверяем
		Timeout:         10 * time.Second,
		// старые ТВ (webOS 3–4) знают только ssh-rsa / старые алгоритмы
		HostKeyAlgorithms: []string{ssh.KeyAlgoRSA, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSASHA512, ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256},
	}
	conf.SetDefaults()
	conf.KeyExchanges = append(conf.KeyExchanges, "diffie-hellman-group14-sha1", "diffie-hellman-group1-sha1", "diffie-hellman-group-exchange-sha256")
	conf.Ciphers = append(conf.Ciphers, "aes128-cbc", "aes256-cbc", "3des-cbc")
	c, err := ssh.Dial("tcp", net.JoinHostPort(ip, port), conf)
	if err != nil {
		if strings.Contains(err.Error(), "unable to authenticate") {
			return nil, errors.New("телевизор не принял ключ — обновите код (Passphrase) и попробуйте снова")
		}
		return nil, fmt.Errorf("не удалось подключиться к телевизору по SSH (порт %s): %v", port, err)
	}
	return c, nil
}

func runCmd(c *ssh.Client, cmd string, stdin io.Reader) (string, error) {
	s, err := c.NewSession()
	if err != nil {
		return "", err
	}
	defer s.Close()
	if stdin != nil {
		s.Stdin = stdin
	}
	var out bytes.Buffer
	s.Stdout = &out
	s.Stderr = &out
	err = s.Run(cmd)
	return out.String(), err
}

// Вызов Luna с первым ответом: «luna-send-pub -n 1» на части ТВ молчит — как LG CLI, через -i,
// после первой строки ответа ввод закрывается (до 15 с)
func lunaOnce(c *ssh.Client, uri string, param interface{}) (string, error) {
	s, err := c.NewSession()
	if err != nil {
		return "", err
	}
	defer s.Close()
	p, _ := json.Marshal(param)
	stdin, _ := s.StdinPipe()
	stdout, _ := s.StdoutPipe()
	if err := s.Start("luna-send-pub -i " + uri + " '" + string(p) + "'"); err != nil {
		return "", err
	}
	line := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			if t := strings.TrimSpace(sc.Text()); strings.HasPrefix(t, "{") {
				line <- t
				return
			}
		}
		line <- ""
	}()
	var out string
	select {
	case out = <-line:
	case <-time.After(15 * time.Second):
	}
	stdin.Close()
	if out == "" {
		return "", errors.New("нет ответа")
	}
	return out, nil
}

// Установка через appInstallService: ждём details.state «installed» или «FAILED» (до 3 минут)
func install(c *ssh.Client, appID, remote string) error {
	s, err := c.NewSession()
	if err != nil {
		return err
	}
	defer s.Close()
	param, _ := json.Marshal(map[string]interface{}{"id": appID, "ipkUrl": remote, "subscribe": true})
	stdin, _ := s.StdinPipe()
	stdout, _ := s.StdoutPipe()
	if err := s.Start("luna-send-pub -i luna://com.webos.appInstallService/dev/install '" + string(param) + "'"); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			line := sc.Text()
			var m map[string]interface{}
			if json.Unmarshal([]byte(line), &m) != nil {
				continue
			}
			if rv, ok := m["returnValue"].(bool); ok && !rv {
				done <- fmt.Errorf("телевизор отказал в установке: %v", m["errorText"])
				return
			}
			d, _ := m["details"].(map[string]interface{})
			state, _ := d["state"].(string)
			if strings.Contains(strings.ToUpper(state), "FAIL") {
				reason := fmt.Sprint(d["reason"])
				if d["errorCode"] != nil {
					reason += fmt.Sprintf(" (код %v)", d["errorCode"])
				}
				done <- errors.New("установка не удалась: " + reason)
				return
			}
			if strings.EqualFold(state, "installed") || strings.Contains(strings.ToUpper(state), "SUCCESS") {
				done <- nil
				return
			}
		}
		done <- errors.New("телевизор прервал установку")
	}()
	select {
	case err = <-done:
	case <-time.After(3 * time.Minute):
		err = errors.New("установка идёт слишком долго — проверьте телевизор")
	}
	stdin.Close()
	return err
}

// Продление сессии режима разработчика (как в приложении Developer Mode): токен — на ТВ
func extendDevMode(c *ssh.Client) (string, error) {
	tok, err := runCmd(c, "cat /var/luna/preferences/devmode_enabled", nil)
	tok = strings.TrimSpace(tok)
	if err != nil || tok == "" {
		return "", errors.New("нет токена сессии (на эмуляторе это нормально)")
	}
	cl := http.Client{Timeout: 10 * time.Second}
	resp, err := cl.Get("https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken=" + tok)
	if err != nil {
		return "", errors.New("нет связи с сервером LG")
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	var r struct {
		Result       string `json:"result"`
		ErrorMsg     string `json:"errorMsg"`
		ErrorMessage string `json:"errorMessage"`
	}
	json.Unmarshal(b, &r)
	if resp.StatusCode == 200 && (r.Result == "success" || strings.Contains(string(b), "success")) {
		return "ещё на 50 часов", nil
	}
	msg := r.ErrorMsg + r.ErrorMessage
	if msg == "" {
		msg = fmt.Sprintf("ответ сервера LG: HTTP %d", resp.StatusCode)
	}
	return "", errors.New(msg)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
