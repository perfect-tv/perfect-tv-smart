"use strict";
var __values = (this && this.__values) || function(o) {
    var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
    if (m) return m.call(o);
    if (o && typeof o.length === "number") return {
        next: function () {
            if (o && i >= o.length) o = void 0;
            return { value: o && o[i++], done: !o };
        }
    };
    throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
};
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = function (target, all) {
    for (var name in all)
        __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = function (to, from, except, desc) {
    var e_1, _a;
    if (from && typeof from === "object" || typeof from === "function") {
        var _loop_1 = function (key) {
            if (!__hasOwnProp.call(to, key) && key !== except)
                __defProp(to, key, { get: function () { return from[key]; }, enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
        };
        try {
            for (var _b = __values(__getOwnPropNames(from)), _c = _b.next(); !_c.done; _c = _b.next()) {
                var key = _c.value;
                _loop_1(key);
            }
        }
        catch (e_1_1) { e_1 = { error: e_1_1 }; }
        finally {
            try {
                if (_c && !_c.done && (_a = _b.return)) _a.call(_b);
            }
            finally { if (e_1) throw e_1.error; }
        }
    }
    return to;
};
var __toCommonJS = function (mod) { return __copyProps(__defProp({}, "__esModule", { value: true }), mod); };
var epg_entry_exports = {};
__export(epg_entry_exports, {
    EpgMatcher: function () { return EpgMatcher; },
    XmltvParser: function () { return XmltvParser; }
});
module.exports = __toCommonJS(epg_entry_exports);
var LT = 60;
var GT = 62;
var SLASH = 47;
var BANG = 33;
var QM = 63;
var QUOT = 34;
var APOS = 39;
var EQ = 61;
function bytes(s) {
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++)
        b[i] = s.charCodeAt(i);
    return b;
}
var B_CHANNEL = bytes("channel");
var B_PROGRAMME = bytes("programme");
var B_CHANNEL_END = bytes("</channel>");
var B_PROGRAMME_END = bytes("</programme>");
var B_COMMENT = bytes("<!--");
var B_COMMENT_END = bytes("-->");
var B_PI_END = bytes("?>");
var B_CHANNEL_ATTR = bytes("channel");
function isSpace(c) {
    return c === 32 || c === 10 || c === 13 || c === 9;
}
function isNameEnd(c) {
    return c === GT || c === SLASH || isSpace(c);
}
function indexOfBytes(b, p, from, to) {
    var end = (to === void 0 ? b.length : to) - p.length;
    var c0 = p[0];
    var n = p.length;
    outer: for (var i = from; i <= end; i++) {
        if (b[i] !== c0)
            continue;
        for (var k = 1; k < n; k++)
            if (b[i + k] !== p[k])
                continue outer;
        return i;
    }
    return -1;
}
function equalsAt(b, from, to, name) {
    if (to - from !== name.length)
        return false;
    for (var k = 0; k < name.length; k++)
        if (b[from + k] !== name[k])
            return false;
    return true;
}
var ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\xA0" };
function unescapeXml(s) {
    if (s.indexOf("&") < 0)
        return s;
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, function (m, e) {
        if (e.charAt(0) === "#") {
            var code = e.charAt(1) === "x" || e.charAt(1) === "X" ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10);
            if (!isFinite(code) || code <= 0)
                return m;
            if (code > 65535) {
                var c = code - 65536;
                return String.fromCharCode(55296 + (c >> 10), 56320 + (c & 1023));
            }
            return String.fromCharCode(code);
        }
        var r = ENT[e];
        return r !== void 0 ? r : m;
    });
}
function textOf(s) {
    var out = "";
    var i = 0;
    for (;;) {
        var c = s.indexOf("<![CDATA[", i);
        var part = c < 0 ? s.substring(i) : s.substring(i, c);
        out += unescapeXml(part.replace(/<[^>]*>/g, ""));
        if (c < 0)
            break;
        var e = s.indexOf("]]>", c + 9);
        if (e < 0) {
            out += s.substring(c + 9);
            break;
        }
        out += s.substring(c + 9, e);
        i = e + 3;
    }
    return out;
}
function attr(tag, name) {
    var re = new RegExp("\\s" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')");
    var m = re.exec(tag);
    if (!m)
        return "";
    return unescapeXml(m[2] !== void 0 ? m[2] : m[3] || "");
}
function daysFromCivil(y0, m, d) {
    var y = m <= 2 ? y0 - 1 : y0;
    var era = Math.floor((y >= 0 ? y : y - 399) / 400);
    var yoe = y - era * 400;
    var doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
}
function parseTime(s0) {
    if (!s0)
        return 0;
    var s = s0.trim();
    var i = 0;
    function num(len) {
        if (i + len > s.length)
            return -1;
        var v = 0;
        for (var k = 0; k < len; k++) {
            var c = s.charCodeAt(i + k) - 48;
            if (c < 0 || c > 9)
                return -1;
            v = v * 10 + c;
        }
        i += len;
        return v;
    }
    var y = num(4), mo = num(2), d = num(2);
    if (y < 0 || mo < 1 || d < 1)
        return 0;
    var h = Math.max(0, num(2)), mi = Math.max(0, num(2)), se = Math.max(0, num(2));
    while (i < s.length && s.charAt(i) === " ")
        i++;
    var offset = 0;
    if (i < s.length && (s.charAt(i) === "+" || s.charAt(i) === "-")) {
        var sign = s.charAt(i) === "-" ? -1 : 1;
        i++;
        var oh = num(2);
        if (i < s.length && s.charAt(i) === ":")
            i++;
        var om = num(2);
        if (oh >= 0)
            offset = sign * (oh * 3600 + Math.max(0, om) * 60);
    }
    return daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se - offset;
}
var Pick = (function () {
    function Pick(langs) {
        this.langs = langs;
        this.value = "";
        this.rank = 1 << 30;
    }
    Pick.prototype.offer = function (lang, text) {
        var r = lang ? this.langs.indexOf(lang.toLowerCase()) : -1;
        if (r < 0)
            r = this.langs.length;
        if (r < this.rank) {
            this.rank = r;
            this.value = text;
        }
    };
    return Pick;
}());
var CHILD_RE = /<(title|sub-title|desc|category|icon|display-name)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1\s*>)/g;
var XmltvParser = (function () {
    function XmltvParser(langs, onChannel, beforeProgrammes, wanted, onProgramme) {
        this.langs = langs;
        this.onChannel = onChannel;
        this.beforeProgrammes = beforeProgrammes;
        this.wanted = wanted;
        this.onProgramme = onProgramme;
        this.channels = 0;
        this.programmes = 0;
        this.skipped = 0;
        this.buf = new Uint8Array(0);
        this.len = 0;
        this.enc = "utf-8";
        this.programmesStarted = false;
        this.channelsDirty = false;
        this.noStop = {};
        this.lastBytes = new Uint8Array(64);
        this.lastLen = -1;
        this.lastId = "";
        this.lastWanted = false;
        this.resumeAt = -1;
        this.decoder = new TextDecoder("utf-8");
    }
    XmltvParser.prototype.decode = function (from, to) {
        return this.decoder.decode(this.buf.subarray(from, to));
    };
    XmltvParser.prototype.push = function (chunk) {
        if (this.len === 0) {
            this.buf = chunk;
            this.len = chunk.length;
        }
        else {
            var nb = new Uint8Array(this.len + chunk.length);
            nb.set(this.buf.subarray(0, this.len), 0);
            nb.set(chunk, this.len);
            this.buf = nb;
            this.len = nb.length;
        }
        var used = this.run(false);
        this.keepTail(used);
    };
    XmltvParser.prototype.end = function () {
        this.run(true);
        this.buf = new Uint8Array(0);
        this.len = 0;
        for (var ch in this.noStop) {
            var pr = this.noStop[ch];
            pr.stop = pr.start + 3600;
            this.emit(pr);
        }
        this.noStop = {};
    };
    XmltvParser.prototype.keepTail = function (used) {
        if (used >= this.len) {
            this.buf = new Uint8Array(0);
            this.len = 0;
            return;
        }
        if (used > 0) {
            this.buf = this.buf.slice(used, this.len);
            this.len = this.buf.length;
            if (this.resumeAt >= 0)
                this.resumeAt -= used;
        }
    };
    XmltvParser.prototype.run = function (final) {
        var b = this.buf;
        var n = this.len;
        var pos = 0;
        while (pos < n) {
            var lt = pos;
            while (lt < n && b[lt] !== LT)
                lt++;
            if (lt >= n)
                return n;
            pos = lt;
            if (lt + 1 >= n)
                return final ? n : lt;
            var c = b[lt + 1];
            if (c === QM) {
                var e = indexOfBytes(b, B_PI_END, lt + 2, n);
                if (e < 0)
                    return final ? n : lt;
                this.prolog(this.latin1(lt, e));
                pos = e + 2;
                continue;
            }
            if (c === BANG) {
                if (lt + 4 > n)
                    return final ? n : lt;
                if (equalsAt(b, lt, lt + 4, B_COMMENT)) {
                    var e = indexOfBytes(b, B_COMMENT_END, lt + 4, n);
                    if (e < 0)
                        return final ? n : lt;
                    pos = e + 3;
                }
                else {
                    var e = lt + 2;
                    while (e < n && b[e] !== GT)
                        e++;
                    if (e >= n)
                        return final ? n : lt;
                    pos = e + 1;
                }
                continue;
            }
            var te = this.tagEnd(lt + 1, n);
            if (te < 0)
                return final ? n : lt;
            var ne = lt + 1;
            while (ne < te && !isNameEnd(b[ne]))
                ne++;
            var selfClosed = b[te - 1] === SLASH;
            if (equalsAt(b, lt + 1, ne, B_CHANNEL)) {
                var end = te + 1;
                if (!selfClosed) {
                    var e = indexOfBytes(b, B_CHANNEL_END, this.resumeAt > te ? this.resumeAt : te + 1, n);
                    if (e < 0) {
                        this.resumeAt = Math.max(te + 1, n - B_CHANNEL_END.length);
                        return final ? n : lt;
                    }
                    end = e + B_CHANNEL_END.length;
                }
                this.resumeAt = -1;
                var s = this.decode(lt, end);
                var id = attr(this.decode(lt, te + 1), "id");
                if (id) {
                    this.channels++;
                    this.onChannel(this.channelOf(id, s));
                    if (this.programmesStarted)
                        this.channelsDirty = true;
                }
                pos = end;
                continue;
            }
            if (equalsAt(b, lt + 1, ne, B_PROGRAMME)) {
                var end = te + 1;
                if (!selfClosed) {
                    var e = indexOfBytes(b, B_PROGRAMME_END, this.resumeAt > te ? this.resumeAt : te + 1, n);
                    if (e < 0) {
                        this.resumeAt = Math.max(te + 1, n - B_PROGRAMME_END.length);
                        return final ? n : lt;
                    }
                    end = e + B_PROGRAMME_END.length;
                }
                this.resumeAt = -1;
                if (!this.programmesStarted || this.channelsDirty) {
                    this.programmesStarted = true;
                    this.channelsDirty = false;
                    this.lastLen = -1;
                    this.beforeProgrammes();
                }
                var r = this.attrRange(ne, te, B_CHANNEL_ATTR);
                if (r === null) {
                    this.skipped++;
                    pos = end;
                    continue;
                }
                var vs = r[0], ve = r[1];
                if (!this.sameAsLast(vs, ve)) {
                    this.lastLen = ve - vs;
                    if (this.lastBytes.length < this.lastLen)
                        this.lastBytes = new Uint8Array(this.lastLen * 2);
                    this.lastBytes.set(b.subarray(vs, ve), 0);
                    this.lastId = unescapeXml(this.decode(vs, ve));
                    this.lastWanted = this.lastId.length > 0 && this.wanted(this.lastId);
                }
                if (!this.lastWanted) {
                    this.skipped++;
                    pos = end;
                    continue;
                }
                var open = this.decode(lt, te + 1);
                this.programme(this.lastId, attr(open, "start"), attr(open, "stop"), selfClosed ? "" : this.decode(te + 1, end));
                pos = end;
                continue;
            }
            pos = te + 1;
        }
        return n;
    };
    XmltvParser.prototype.latin1 = function (from, to) {
        var s = "";
        for (var i = from; i < to; i++)
            s += String.fromCharCode(this.buf[i]);
        return s;
    };
    XmltvParser.prototype.tagEnd = function (from, n) {
        var b = this.buf;
        var q = 0;
        for (var i = from; i < n; i++) {
            var c = b[i];
            if (q) {
                if (c === q)
                    q = 0;
            }
            else if (c === QUOT || c === APOS)
                q = c;
            else if (c === GT)
                return i;
        }
        return -1;
    };
    XmltvParser.prototype.attrRange = function (from, to, name) {
        var b = this.buf;
        var i = from;
        while (i < to) {
            while (i < to && isSpace(b[i]))
                i++;
            var ns = i;
            while (i < to && b[i] !== EQ && !isSpace(b[i]) && b[i] !== GT && b[i] !== SLASH)
                i++;
            var nameEnd = i;
            while (i < to && isSpace(b[i]))
                i++;
            if (i >= to || b[i] !== EQ) {
                i++;
                continue;
            }
            i++;
            while (i < to && isSpace(b[i]))
                i++;
            var q = b[i];
            if (q !== QUOT && q !== APOS) {
                i++;
                continue;
            }
            var vs = i + 1;
            var ve = vs;
            while (ve < to && b[ve] !== q)
                ve++;
            if (equalsAt(b, ns, nameEnd, name))
                return [vs, ve];
            i = ve + 1;
        }
        return null;
    };
    XmltvParser.prototype.sameAsLast = function (vs, ve) {
        if (ve - vs !== this.lastLen)
            return false;
        var b = this.buf;
        for (var k = 0; k < this.lastLen; k++)
            if (b[vs + k] !== this.lastBytes[k])
                return false;
        return true;
    };
    XmltvParser.prototype.prolog = function (s) {
        var m = /encoding\s*=\s*["']([^"']+)["']/.exec(s);
        if (!m)
            return;
        var enc = m[1].toLowerCase();
        if (enc === this.enc)
            return;
        try {
            this.decoder = new TextDecoder(enc);
            this.enc = enc;
        }
        catch (e) {
        }
    };
    XmltvParser.prototype.channelOf = function (id, s) {
        var names = [];
        var icon = "";
        CHILD_RE.lastIndex = 0;
        var m;
        while ((m = CHILD_RE.exec(s)) !== null) {
            if (m[1] === "display-name") {
                var t = textOf(m[4] || "").trim();
                if (t && names.indexOf(t) < 0)
                    names.push(t);
            }
            else if (m[1] === "icon" && !icon)
                icon = attr(" " + m[2], "src");
        }
        return { id: id, names: names, icon: icon };
    };
    XmltvParser.prototype.programme = function (ch, startAttr, stopAttr, inner) {
        var start = parseTime(startAttr);
        if (start <= 0)
            return;
        var stop = stopAttr ? parseTime(stopAttr) : 0;
        var title = new Pick(this.langs), sub = new Pick(this.langs), desc = new Pick(this.langs), cat = new Pick(this.langs);
        var icon = "";
        if (inner) {
            CHILD_RE.lastIndex = 0;
            var m = void 0;
            while ((m = CHILD_RE.exec(inner)) !== null) {
                var name = m[1];
                if (name === "icon") {
                    if (!icon)
                        icon = attr(" " + m[2], "src");
                    continue;
                }
                var lang = attr(" " + m[2], "lang");
                var text = m[4] !== void 0 ? textOf(m[4]) : "";
                if (name === "title")
                    title.offer(lang, text);
                else if (name === "sub-title")
                    sub.offer(lang, text);
                else if (name === "desc")
                    desc.offer(lang, text);
                else if (name === "category")
                    cat.offer(lang, text);
            }
        }
        var pr = {
            channel: ch,
            start: start,
            stop: stop,
            title: title.value.trim(),
            subTitle: sub.value.trim(),
            desc: desc.value.trim(),
            category: cat.value.trim(),
            icon: icon
        };
        var prev = this.noStop[ch];
        if (prev) {
            delete this.noStop[ch];
            prev.stop = Math.max(start, prev.start + 60);
            this.emit(prev);
        }
        if (stop <= start)
            this.noStop[ch] = pr;
        else
            this.emit(pr);
    };
    XmltvParser.prototype.emit = function (pr) {
        this.programmes++;
        this.onProgramme(pr);
    };
    return XmltvParser;
}());
var KEY_RE = /[\s!-\/:-@\[-`\{-~]+/g;
var TR = {
    "\u0451": "e",
    "\u0443": "y",
    "\u043A": "k",
    "\u0435": "e",
    "\u043D": "h",
    "\u0448": "w",
    "\u0437": "3",
    "\u0445": "x",
    "\u044B": "bl",
    "\u0432": "b",
    "\u0430": "a",
    "\u0440": "p",
    "\u043E": "o",
    "\u0447": "4",
    "\u0441": "c",
    "\u043C": "m",
    "\u0442": "t",
    "\u044C": "b",
    "\u0431": "6"
};
var R_ARCHIVE = /\s+\(архив\)$/;
var R_PLUS = /\s+\((\+\d+)\)/g;
var R_TELE = /^телеканал\s+/;
var R_SIGNS = /([!\s.,()–-]+|ⓢ|ⓖ|ⓥ|ⓞ|Ⓢ|Ⓖ|Ⓥ|Ⓞ)/g;
var R_KANAL = /\s(канал|тв)(\s.+|\s*)$/;
var R_ORIG = /\s(50|orig|original)$/;
var R_NUM = /\s(\d+)/g;
var LETTER = /[0-9A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;
var DIGIT = /[0-9]/;
var Names = {
    key: function (name) {
        return name.toLowerCase().replace(KEY_RE, "");
    },
    short: function (name) {
        return name.toLowerCase().replace(R_ARCHIVE, "").replace(R_PLUS, " $1").replace(R_TELE, "").replace(R_SIGNS, " ").trim().replace(R_KANAL, "$2").replace(R_ORIG, "").replace(R_NUM, "$1");
    },
    translit: function (s) {
        var r = "";
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            r += TR[c] !== void 0 ? TR[c] : c;
        }
        return r;
    },
    matchKey: function (name) {
        return Names.translit(Names.short(name));
    },
    monogram: function (name) {
        var sb = "";
        var words = 0;
        var first = "";
        var i = 0;
        var n = name.length;
        while (i < n) {
            while (i < n && !LETTER.test(name.charAt(i)))
                i++;
            var s = i;
            while (i < n && LETTER.test(name.charAt(i)))
                i++;
            if (i === s)
                break;
            if (words++ === 0)
                first = name.substring(s, i);
            if (sb.length >= 3)
                continue;
            if (DIGIT.test(name.charAt(s)))
                sb += name.substring(s, Math.min(i, s + 3 - sb.length));
            else
                sb += name.charAt(s);
        }
        if (words === 0)
            return "?";
        if (words === 1)
            return (first.length <= 3 ? first : first.substring(0, 2)).toUpperCase();
        return sb.toUpperCase();
    }
};
var EpgMatcher = (function () {
    function EpgMatcher() {
        this.ids = {};
        this.idsLower = {};
        this.byName = {};
        this.size = 0;
    }
    EpgMatcher.prototype.addChannel = function (c) {
        if (!this.ids[c.id]) {
            this.ids[c.id] = true;
            this.size++;
        }
        var low = c.id.toLowerCase();
        if (this.idsLower[low] === void 0)
            this.idsLower[low] = c.id;
        for (var i = 0; i < c.names.length; i++) {
            var k = Names.matchKey(c.names[i]);
            if (k && this.byName[k] === void 0)
                this.byName[k] = c.id;
        }
    };
    EpgMatcher.prototype.match = function (tvgId, tvgName, name) {
        if (tvgId) {
            if (this.ids[tvgId])
                return tvgId;
            var l = this.idsLower[tvgId.toLowerCase()];
            if (l !== void 0)
                return l;
        }
        if (tvgName) {
            var v2 = this.byName[Names.matchKey(tvgName)];
            if (v2 !== void 0)
                return v2;
        }
        var v = this.byName[Names.matchKey(name)];
        return v !== void 0 ? v : null;
    };
    return EpgMatcher;
}());
0 && (module.exports = {
    EpgMatcher: EpgMatcher,
    XmltvParser: XmltvParser
});
