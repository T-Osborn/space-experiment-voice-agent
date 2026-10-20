const DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNITS = { 十: 10, 百: 100, 千: 1000 };
const NUMBER_PATTERN = /(?:零下|负|[-−])?\s*(?:\d+(?:[.点]\d+)?|\.\d+|[零〇一二两三四五六七八九十百千]+(?:[.点][零〇一二两三四五六七八九\d]+)?)/gu;

function hasWrongUnit(input, text) {
  if (!input.unit) return false;
  const mentioned = text.match(/摄氏度|摄氏|华氏度|华氏|开尔文|小时|分钟|毫秒|秒钟|秒|天|日|周|年|个月|月|百分之|百分比|%|℃|℉|°\s*[CF]|毫升|升|毫克|千克|克|兆帕|千帕|帕斯卡|MPa|kPa|毫米|厘米|米|度|kelvin|fahrenheit|celsius|(?<=[\d零〇一二两三四五六七八九十百千])[CFK]\b/giu) || [];
  const units = {
    天: new Set(["天", "日"]),
    "℃": new Set(["℃", "摄氏度", "摄氏", "度", "°c", "c", "celsius"]),
    "%": new Set(["%", "百分之", "百分比"]),
  };
  const accepted = units[input.unit] || new Set([input.unit.toLowerCase()]);
  return mentioned.some(unit => !accepted.has(unit.toLowerCase().replace(/\s/gu, "")));
}

function parseInteger(text) {
  if (/^\d+$/u.test(text)) return Number(text);
  if ([...text].every((char) => char in DIGITS)) return Number([...text].map((char) => DIGITS[char]).join(""));
  let total = 0;
  let digit = null;
  let lastUnit = Infinity;
  let explicitZero = false;
  for (const char of text) {
    if (char in DIGITS) {
      if (digit !== null && digit !== 0) return null;
      digit = DIGITS[char];
      if (digit === 0) explicitZero = true;
    } else if (char in UNITS) {
      const unit = UNITS[char];
      if (unit >= lastUnit || (digit === null && unit !== 10)) return null;
      total += (digit ?? 1) * unit;
      lastUnit = unit;
      explicitZero = false;
      digit = null;
    } else return null;
  }
  // "一百五" can mean 105 or 150 in speech; require a precise report.
  if (lastUnit >= 100 && lastUnit !== Infinity && digit && !explicitZero) return null;
  return total + (digit ?? 0);
}

function parseSpokenNumber(token) {
  let text = token.replace(/\s/gu, "");
  const negative = /^(零下|负|[-−])/u.test(text);
  text = text.replace(/^(零下|负|[-−])/u, "");
  const parts = text.split(/[.点]/u);
  const integer = parseInteger(parts[0] || "0");
  if (integer === null || parts.length > 2) return null;
  let fraction = 0;
  if (parts.length === 2) {
    const digits = [...parts[1]].map((char) => /\d/u.test(char) ? char : DIGITS[char]);
    if (!digits.length || digits.some((digit) => digit === undefined)) return null;
    fraction = Number(`0.${digits.join("")}`);
  }
  const number = (integer + fraction) * (negative ? -1 : 1);
  return Number.isFinite(number) ? number : null;
}

function readValue(input, text) {
  if (/(不确定|可能|也许|大概|应该|似乎|还不清楚|没看清|预计|准备|计划|将要|将为)/u.test(text)) return { value: null, ambiguous: true };
  if (input.type !== "boolean" && /(不是|并非|不为)/u.test(text)) return { value: null, ambiguous: true };
  if (input.type === "identifier" || input.type === "datetime_utc") {
    const raw = text.trim().replace(/^(?:是|为|更正为|改为|：|:)\s*/u, "").replace(/[。.]$/u, "");
    const value = input.type === "datetime_utc" ? parseUtc(raw) : parseIdentifier(raw, input.max_length);
    return { value, ambiguous: !!raw && value === null };
  }
  if (input.type === "number") {
    if (hasWrongUnit(input, text)) return { value: null, ambiguous: true };
    const matches = [...text.replace(/百分之/gu, "").matchAll(NUMBER_PATTERN)];
    if (matches.length === 0) return { value: null };
    if (matches.length !== 1 || /(低于|高于|大于|小于|至少|超过|不足|大概|左右|约|范围|±|到|至)/u.test(text)) return { value: null, ambiguous: true };
    const value = parseSpokenNumber(matches[0][0]);
    return { value, ambiguous: value === null };
  }
  if (input.type === "boolean") {
    if (/(未完成|没有完成|没完成|未核对|未复核)/u.test(text)
      && /(已完成|已经完成|已核对|已复核)/u.test(text)) return { value: null, ambiguous: true };
    if (/(不是|并非|不能确认|无法确认)/u.test(text) && !/^不是[。.]?$/u.test(text)) return { value: null, ambiguous: true };
    if (/(待完成|待记录|将完成|准备完成|准备记录|待核对|准备核对|待复核)/u.test(text)) return { value: null };
    if (/(尚未|还没|没有完成|没有记录|没完成|没记录|(?:没有|没|未)(?:完成|记录|执行|通过|确认|保存|入柜|核对|复核)|不正常|不达标|失败|缺失|^否$|^不是$)/u.test(text)) return { value: false };
    if (/(已完成|已经完成|完成|完毕|已记录|记录完整|正常|通过|达标|已确认|已核对|已复核|已采集|已保存|已入柜|无异常|没有异常|^是$|^是的$)/u.test(text)) return { value: true };
    return { value: null };
  }
  if (input.type === "enum") {
    const candidates = Object.entries(input.options || {}).flatMap(([key, values]) => values.map((value) => ({ key, value })));
    const matches = [];
    for (const candidate of candidates) {
      let start = text.indexOf(candidate.value);
      while (start >= 0) {
        matches.push({ ...candidate, start, end: start + candidate.value.length });
        start = text.indexOf(candidate.value, start + candidate.value.length);
      }
    }
    const longestMatches = matches.filter((match) => !matches.some((other) => other.start <= match.start && other.end >= match.end && other.value.length > match.value.length));
    const keys = new Set(longestMatches.map((match) => match.key));
    if (keys.size > 1) return { value: null, ambiguous: true };
    return { value: keys.size === 1 ? [...keys][0] : null };
  }
  return { value: null };
}

function isStandaloneAnswer(input, query) {
  if (input.type === "datetime_utc") return parseUtc(query) !== null;
  if (input.type === "identifier") return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/u.test(query);
  if (input.type === "number") {
    return query.replace(/百分之/gu, "").replace(NUMBER_PATTERN, "").replace(/(摄氏度|华氏度|摄氏|华氏|开尔文|小时|分钟|秒|天|日|周|年|个月|月|度|℃|℉|°\s*[CF]|[CFK]|%|是|为|当前|现在|更正为|改为|剩余|余量|温度)/giu, "").replace(/[\s，。,.]/gu, "") === "";
  }
  if (input.type === "boolean") return /^(是|是的|否|不是|正常|不正常|已完成|已经完成|完成|未完成|已核对|未核对|已复核|未复核|核对完成|复核完成|已记录|未记录|已保存|未保存|已入柜|未入柜|记录完整)[。.]?$/u.test(query);
  if (input.type === "enum") return Object.values(input.options || {}).flat().includes(query.replace(/[。.]$/u, ""));
  return false;
}

function extractStepInputs(step, query, observations = {}) {
  const text = String(query).normalize("NFKC");
  const inputs = step.required_inputs || [];
  const anchors = [];
  for (const input of inputs) {
    for (const alias of input.aliases || [input.label || input.name]) {
      let start = text.toLowerCase().indexOf(alias.toLowerCase());
      while (start >= 0) {
        anchors.push({ input, start, end: start + alias.length });
        start = text.toLowerCase().indexOf(alias.toLowerCase(), start + alias.length);
      }
    }
  }
  // A short alias inside another field's longer alias does not own that field's value.
  const selected = [];
  for (const anchor of anchors.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)) {
    if (!selected.some((other) => anchor.start < other.end && other.start < anchor.end)) selected.push(anchor);
  }
  selected.sort((a, b) => a.start - b.start);
  const values = {};
  const ambiguous = new Set();
  function add(input, result) {
    if (result.ambiguous || (result.value !== null && values[input.name] !== undefined && values[input.name] !== result.value)) ambiguous.add(input.name);
    else if (result.value !== null) values[input.name] = result.value;
  }
  for (let i = 0; i < selected.length; i += 1) {
    const anchor = selected[i];
    const end = selected[i + 1]?.start ?? text.length;
    const context = text.slice(anchor.end, end).split(/[，,。；;\n]/u)[0].trim();
    // Keep enum aliases (e.g. "种子成熟") because the value can be in the alias itself.
    add(anchor.input, readValue(anchor.input, anchor.input.type === "enum" ? text.slice(anchor.start, anchor.end) + context : context));
  }
  if (selected.length === 0) {
    const input = inputs.find((item) => observations[item.name] === undefined) || (inputs.length === 1 ? inputs[0] : null);
    if (input && isStandaloneAnswer(input, text)) add(input, readValue(input, text));
  }
  for (const field of ambiguous) delete values[field];
  return { values, ambiguous: [...ambiguous] };
}

function parseIdentifier(text, maxLength = 64) {
  if (!text || text.length > maxLength || /[\s<>{}\[\]"'\\]/u.test(text)
    || /^(?:已记录|已填写|已完成|记录完整|未知|不知道|未记录|无|没有|确认无误|下一步|继续)$/u.test(text)
    || !/^[\p{L}\p{N}][\p{L}\p{N}._:/-]*$/u.test(text)) return null;
  // Preserve the recognized identifier verbatim; never invent an ASR correction.
  return text;
}

function parseUtc(text) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/iu.exec(text);
  const spoken = /^(?:UTC\s*)?(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2})(?:时|点)(\d{1,2})分(\d{1,2})秒(?:\s*UTC)?$/iu.exec(text);
  const match = iso || spoken;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (year < 1000 || year > 9999) return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;
  return date.toISOString().replace(".000Z", "Z");
}

module.exports = { extractStepInputs, parseSpokenNumber, parseUtc, parseIdentifier };
