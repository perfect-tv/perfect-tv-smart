// A single parser implementation shared between the UI and Node.js service.
// The service build emits a CommonJS ES5 bundle without browser dependencies.
export { XmltvParser } from '../data/xmltv';
export { EpgMatcher } from '../data/matcher';
