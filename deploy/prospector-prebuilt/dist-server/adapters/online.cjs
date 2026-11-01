"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/postgres-array/index.js
var require_postgres_array = __commonJS({
  "node_modules/postgres-array/index.js"(exports2) {
    "use strict";
    exports2.parse = function(source, transform) {
      return new ArrayParser(source, transform).parse();
    };
    var ArrayParser = class _ArrayParser {
      constructor(source, transform) {
        this.source = source;
        this.transform = transform || identity;
        this.position = 0;
        this.entries = [];
        this.recorded = [];
        this.dimension = 0;
      }
      isEof() {
        return this.position >= this.source.length;
      }
      nextCharacter() {
        var character = this.source[this.position++];
        if (character === "\\") {
          return {
            value: this.source[this.position++],
            escaped: true
          };
        }
        return {
          value: character,
          escaped: false
        };
      }
      record(character) {
        this.recorded.push(character);
      }
      newEntry(includeEmpty) {
        var entry;
        if (this.recorded.length > 0 || includeEmpty) {
          entry = this.recorded.join("");
          if (entry === "NULL" && !includeEmpty) {
            entry = null;
          }
          if (entry !== null)
            entry = this.transform(entry);
          this.entries.push(entry);
          this.recorded = [];
        }
      }
      consumeDimensions() {
        if (this.source[0] === "[") {
          while (!this.isEof()) {
            var char = this.nextCharacter();
            if (char.value === "=")
              break;
          }
        }
      }
      parse(nested) {
        var character, parser, quote2;
        this.consumeDimensions();
        while (!this.isEof()) {
          character = this.nextCharacter();
          if (character.value === "{" && !quote2) {
            this.dimension++;
            if (this.dimension > 1) {
              parser = new _ArrayParser(this.source.substr(this.position - 1), this.transform);
              this.entries.push(parser.parse(true));
              this.position += parser.position - 2;
            }
          } else if (character.value === "}" && !quote2) {
            this.dimension--;
            if (!this.dimension) {
              this.newEntry();
              if (nested)
                return this.entries;
            }
          } else if (character.value === '"' && !character.escaped) {
            if (quote2)
              this.newEntry(true);
            quote2 = !quote2;
          } else if (character.value === "," && !quote2) {
            this.newEntry();
          } else {
            this.record(character.value);
          }
        }
        if (this.dimension !== 0) {
          throw new Error("array dimension not balanced");
        }
        return this.entries;
      }
    };
    function identity(value2) {
      return value2;
    }
  }
});

// node_modules/pg-types/lib/arrayParser.js
var require_arrayParser = __commonJS({
  "node_modules/pg-types/lib/arrayParser.js"(exports2, module2) {
    var array = require_postgres_array();
    module2.exports = {
      create: function(source, transform) {
        return {
          parse: function() {
            return array.parse(source, transform);
          }
        };
      }
    };
  }
});

// node_modules/postgres-date/index.js
var require_postgres_date = __commonJS({
  "node_modules/postgres-date/index.js"(exports2, module2) {
    "use strict";
    var DATE_TIME = /(\d{1,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,})?.*?( BC)?$/;
    var DATE = /^(\d{1,})-(\d{2})-(\d{2})( BC)?$/;
    var TIME_ZONE = /([Z+-])(\d{2})?:?(\d{2})?:?(\d{2})?/;
    var INFINITY = /^-?infinity$/;
    module2.exports = function parseDate(isoDate) {
      if (INFINITY.test(isoDate)) {
        return Number(isoDate.replace("i", "I"));
      }
      var matches = DATE_TIME.exec(isoDate);
      if (!matches) {
        return getDate(isoDate) || null;
      }
      var isBC = !!matches[8];
      var year = parseInt(matches[1], 10);
      if (isBC) {
        year = bcYearToNegativeYear(year);
      }
      var month = parseInt(matches[2], 10) - 1;
      var day = matches[3];
      var hour = parseInt(matches[4], 10);
      var minute = parseInt(matches[5], 10);
      var second = parseInt(matches[6], 10);
      var ms = matches[7];
      ms = ms ? 1e3 * parseFloat(ms) : 0;
      var date;
      var offset = timeZoneOffset(isoDate);
      if (offset != null) {
        date = new Date(Date.UTC(year, month, day, hour, minute, second, ms));
        if (is0To99(year)) {
          date.setUTCFullYear(year);
        }
        if (offset !== 0) {
          date.setTime(date.getTime() - offset);
        }
      } else {
        date = new Date(year, month, day, hour, minute, second, ms);
        if (is0To99(year)) {
          date.setFullYear(year);
        }
      }
      return date;
    };
    function getDate(isoDate) {
      var matches = DATE.exec(isoDate);
      if (!matches) {
        return;
      }
      var year = parseInt(matches[1], 10);
      var isBC = !!matches[4];
      if (isBC) {
        year = bcYearToNegativeYear(year);
      }
      var month = parseInt(matches[2], 10) - 1;
      var day = matches[3];
      var date = new Date(year, month, day);
      if (is0To99(year)) {
        date.setFullYear(year);
      }
      return date;
    }
    function timeZoneOffset(isoDate) {
      if (isoDate.endsWith("+00")) {
        return 0;
      }
      var zone = TIME_ZONE.exec(isoDate.split(" ")[1]);
      if (!zone)
        return;
      var type = zone[1];
      if (type === "Z") {
        return 0;
      }
      var sign2 = type === "-" ? -1 : 1;
      var offset = parseInt(zone[2], 10) * 3600 + parseInt(zone[3] || 0, 10) * 60 + parseInt(zone[4] || 0, 10);
      return offset * sign2 * 1e3;
    }
    function bcYearToNegativeYear(year) {
      return -(year - 1);
    }
    function is0To99(num) {
      return num >= 0 && num < 100;
    }
  }
});

// node_modules/xtend/mutable.js
var require_mutable = __commonJS({
  "node_modules/xtend/mutable.js"(exports2, module2) {
    module2.exports = extend;
    var hasOwnProperty = Object.prototype.hasOwnProperty;
    function extend(target) {
      for (var i = 1; i < arguments.length; i++) {
        var source = arguments[i];
        for (var key in source) {
          if (hasOwnProperty.call(source, key)) {
            target[key] = source[key];
          }
        }
      }
      return target;
    }
  }
});

// node_modules/postgres-interval/index.js
var require_postgres_interval = __commonJS({
  "node_modules/postgres-interval/index.js"(exports2, module2) {
    "use strict";
    var extend = require_mutable();
    module2.exports = PostgresInterval;
    function PostgresInterval(raw) {
      if (!(this instanceof PostgresInterval)) {
        return new PostgresInterval(raw);
      }
      extend(this, parse(raw));
    }
    var properties = ["seconds", "minutes", "hours", "days", "months", "years"];
    PostgresInterval.prototype.toPostgres = function() {
      var filtered = properties.filter(this.hasOwnProperty, this);
      if (this.milliseconds && filtered.indexOf("seconds") < 0) {
        filtered.push("seconds");
      }
      if (filtered.length === 0)
        return "0";
      return filtered.map(function(property) {
        var value2 = this[property] || 0;
        if (property === "seconds" && this.milliseconds) {
          value2 = (value2 + this.milliseconds / 1e3).toFixed(6).replace(/\.?0+$/, "");
        }
        return value2 + " " + property;
      }, this).join(" ");
    };
    var propertiesISOEquivalent = {
      years: "Y",
      months: "M",
      days: "D",
      hours: "H",
      minutes: "M",
      seconds: "S"
    };
    var dateProperties = ["years", "months", "days"];
    var timeProperties = ["hours", "minutes", "seconds"];
    PostgresInterval.prototype.toISOString = PostgresInterval.prototype.toISO = function() {
      var datePart = dateProperties.map(buildProperty, this).join("");
      var timePart = timeProperties.map(buildProperty, this).join("");
      return "P" + datePart + "T" + timePart;
      function buildProperty(property) {
        var value2 = this[property] || 0;
        if (property === "seconds" && this.milliseconds) {
          value2 = (value2 + this.milliseconds / 1e3).toFixed(6).replace(/0+$/, "");
        }
        return value2 + propertiesISOEquivalent[property];
      }
    };
    var NUMBER = "([+-]?\\d+)";
    var YEAR = NUMBER + "\\s+years?";
    var MONTH = NUMBER + "\\s+mons?";
    var DAY = NUMBER + "\\s+days?";
    var TIME = "([+-])?([\\d]*):(\\d\\d):(\\d\\d)\\.?(\\d{1,6})?";
    var INTERVAL = new RegExp([YEAR, MONTH, DAY, TIME].map(function(regexString) {
      return "(" + regexString + ")?";
    }).join("\\s*"));
    var positions = {
      years: 2,
      months: 4,
      days: 6,
      hours: 9,
      minutes: 10,
      seconds: 11,
      milliseconds: 12
    };
    var negatives = ["hours", "minutes", "seconds", "milliseconds"];
    function parseMilliseconds(fraction) {
      var microseconds = fraction + "000000".slice(fraction.length);
      return parseInt(microseconds, 10) / 1e3;
    }
    function parse(interval) {
      if (!interval)
        return {};
      var matches = INTERVAL.exec(interval);
      var isNegative = matches[8] === "-";
      return Object.keys(positions).reduce(function(parsed, property) {
        var position = positions[property];
        var value2 = matches[position];
        if (!value2)
          return parsed;
        value2 = property === "milliseconds" ? parseMilliseconds(value2) : parseInt(value2, 10);
        if (!value2)
          return parsed;
        if (isNegative && ~negatives.indexOf(property)) {
          value2 *= -1;
        }
        parsed[property] = value2;
        return parsed;
      }, {});
    }
  }
});

// node_modules/postgres-bytea/index.js
var require_postgres_bytea = __commonJS({
  "node_modules/postgres-bytea/index.js"(exports2, module2) {
    "use strict";
    var bufferFrom = Buffer.from || Buffer;
    module2.exports = function parseBytea(input) {
      if (/^\\x/.test(input)) {
        return bufferFrom(input.substr(2), "hex");
      }
      var output = "";
      var i = 0;
      while (i < input.length) {
        if (input[i] !== "\\") {
          output += input[i];
          ++i;
        } else {
          if (/[0-7]{3}/.test(input.substr(i + 1, 3))) {
            output += String.fromCharCode(parseInt(input.substr(i + 1, 3), 8));
            i += 4;
          } else {
            var backslashes = 1;
            while (i + backslashes < input.length && input[i + backslashes] === "\\") {
              backslashes++;
            }
            for (var k = 0; k < Math.floor(backslashes / 2); ++k) {
              output += "\\";
            }
            i += Math.floor(backslashes / 2) * 2;
          }
        }
      }
      return bufferFrom(output, "binary");
    };
  }
});

// node_modules/pg-types/lib/textParsers.js
var require_textParsers = __commonJS({
  "node_modules/pg-types/lib/textParsers.js"(exports2, module2) {
    var array = require_postgres_array();
    var arrayParser = require_arrayParser();
    var parseDate = require_postgres_date();
    var parseInterval = require_postgres_interval();
    var parseByteA = require_postgres_bytea();
    function allowNull(fn) {
      return function nullAllowed(value2) {
        if (value2 === null)
          return value2;
        return fn(value2);
      };
    }
    function parseBool(value2) {
      if (value2 === null)
        return value2;
      return value2 === "TRUE" || value2 === "t" || value2 === "true" || value2 === "y" || value2 === "yes" || value2 === "on" || value2 === "1";
    }
    function parseBoolArray(value2) {
      if (!value2)
        return null;
      return array.parse(value2, parseBool);
    }
    function parseBaseTenInt(string2) {
      return parseInt(string2, 10);
    }
    function parseIntegerArray(value2) {
      if (!value2)
        return null;
      return array.parse(value2, allowNull(parseBaseTenInt));
    }
    function parseBigIntegerArray(value2) {
      if (!value2)
        return null;
      return array.parse(value2, allowNull(function(entry) {
        return parseBigInteger(entry).trim();
      }));
    }
    var parsePointArray = function(value2) {
      if (!value2) {
        return null;
      }
      var p = arrayParser.create(value2, function(entry) {
        if (entry !== null) {
          entry = parsePoint(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseFloatArray = function(value2) {
      if (!value2) {
        return null;
      }
      var p = arrayParser.create(value2, function(entry) {
        if (entry !== null) {
          entry = parseFloat(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseStringArray = function(value2) {
      if (!value2) {
        return null;
      }
      var p = arrayParser.create(value2);
      return p.parse();
    };
    var parseDateArray = function(value2) {
      if (!value2) {
        return null;
      }
      var p = arrayParser.create(value2, function(entry) {
        if (entry !== null) {
          entry = parseDate(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseIntervalArray = function(value2) {
      if (!value2) {
        return null;
      }
      var p = arrayParser.create(value2, function(entry) {
        if (entry !== null) {
          entry = parseInterval(entry);
        }
        return entry;
      });
      return p.parse();
    };
    var parseByteAArray = function(value2) {
      if (!value2) {
        return null;
      }
      return array.parse(value2, allowNull(parseByteA));
    };
    var parseInteger = function(value2) {
      return parseInt(value2, 10);
    };
    var parseBigInteger = function(value2) {
      var valStr = String(value2);
      if (/^\d+$/.test(valStr)) {
        return valStr;
      }
      return value2;
    };
    var parseJsonArray = function(value2) {
      if (!value2) {
        return null;
      }
      return array.parse(value2, allowNull(JSON.parse));
    };
    var parsePoint = function(value2) {
      if (value2[0] !== "(") {
        return null;
      }
      value2 = value2.substring(1, value2.length - 1).split(",");
      return {
        x: parseFloat(value2[0]),
        y: parseFloat(value2[1])
      };
    };
    var parseCircle = function(value2) {
      if (value2[0] !== "<" && value2[1] !== "(") {
        return null;
      }
      var point = "(";
      var radius = "";
      var pointParsed = false;
      for (var i = 2; i < value2.length - 1; i++) {
        if (!pointParsed) {
          point += value2[i];
        }
        if (value2[i] === ")") {
          pointParsed = true;
          continue;
        } else if (!pointParsed) {
          continue;
        }
        if (value2[i] === ",") {
          continue;
        }
        radius += value2[i];
      }
      var result2 = parsePoint(point);
      result2.radius = parseFloat(radius);
      return result2;
    };
    var init = function(register) {
      register(20, parseBigInteger);
      register(21, parseInteger);
      register(23, parseInteger);
      register(26, parseInteger);
      register(700, parseFloat);
      register(701, parseFloat);
      register(16, parseBool);
      register(1082, parseDate);
      register(1114, parseDate);
      register(1184, parseDate);
      register(600, parsePoint);
      register(651, parseStringArray);
      register(718, parseCircle);
      register(1e3, parseBoolArray);
      register(1001, parseByteAArray);
      register(1005, parseIntegerArray);
      register(1007, parseIntegerArray);
      register(1028, parseIntegerArray);
      register(1016, parseBigIntegerArray);
      register(1017, parsePointArray);
      register(1021, parseFloatArray);
      register(1022, parseFloatArray);
      register(1231, parseFloatArray);
      register(1014, parseStringArray);
      register(1015, parseStringArray);
      register(1008, parseStringArray);
      register(1009, parseStringArray);
      register(1040, parseStringArray);
      register(1041, parseStringArray);
      register(1115, parseDateArray);
      register(1182, parseDateArray);
      register(1185, parseDateArray);
      register(1186, parseInterval);
      register(1187, parseIntervalArray);
      register(17, parseByteA);
      register(114, JSON.parse.bind(JSON));
      register(3802, JSON.parse.bind(JSON));
      register(199, parseJsonArray);
      register(3807, parseJsonArray);
      register(3907, parseStringArray);
      register(2951, parseStringArray);
      register(791, parseStringArray);
      register(1183, parseStringArray);
      register(1270, parseStringArray);
    };
    module2.exports = {
      init
    };
  }
});

// node_modules/pg-int8/index.js
var require_pg_int8 = __commonJS({
  "node_modules/pg-int8/index.js"(exports2, module2) {
    "use strict";
    var BASE = 1e6;
    function readInt8(buffer) {
      var high = buffer.readInt32BE(0);
      var low = buffer.readUInt32BE(4);
      var sign2 = "";
      if (high < 0) {
        high = ~high + (low === 0);
        low = ~low + 1 >>> 0;
        sign2 = "-";
      }
      var result2 = "";
      var carry;
      var t;
      var digits;
      var pad;
      var l;
      var i;
      {
        carry = high % BASE;
        high = high / BASE >>> 0;
        t = 4294967296 * carry + low;
        low = t / BASE >>> 0;
        digits = "" + (t - BASE * low);
        if (low === 0 && high === 0) {
          return sign2 + digits + result2;
        }
        pad = "";
        l = 6 - digits.length;
        for (i = 0; i < l; i++) {
          pad += "0";
        }
        result2 = pad + digits + result2;
      }
      {
        carry = high % BASE;
        high = high / BASE >>> 0;
        t = 4294967296 * carry + low;
        low = t / BASE >>> 0;
        digits = "" + (t - BASE * low);
        if (low === 0 && high === 0) {
          return sign2 + digits + result2;
        }
        pad = "";
        l = 6 - digits.length;
        for (i = 0; i < l; i++) {
          pad += "0";
        }
        result2 = pad + digits + result2;
      }
      {
        carry = high % BASE;
        high = high / BASE >>> 0;
        t = 4294967296 * carry + low;
        low = t / BASE >>> 0;
        digits = "" + (t - BASE * low);
        if (low === 0 && high === 0) {
          return sign2 + digits + result2;
        }
        pad = "";
        l = 6 - digits.length;
        for (i = 0; i < l; i++) {
          pad += "0";
        }
        result2 = pad + digits + result2;
      }
      {
        carry = high % BASE;
        t = 4294967296 * carry + low;
        digits = "" + t % BASE;
        return sign2 + digits + result2;
      }
    }
    module2.exports = readInt8;
  }
});

// node_modules/pg-types/lib/binaryParsers.js
var require_binaryParsers = __commonJS({
  "node_modules/pg-types/lib/binaryParsers.js"(exports2, module2) {
    var parseInt64 = require_pg_int8();
    var parseBits = function(data, bits, offset, invert, callback) {
      offset = offset || 0;
      invert = invert || false;
      callback = callback || function(lastValue, newValue, bits2) {
        return lastValue * Math.pow(2, bits2) + newValue;
      };
      var offsetBytes = offset >> 3;
      var inv = function(value2) {
        if (invert) {
          return ~value2 & 255;
        }
        return value2;
      };
      var mask = 255;
      var firstBits = 8 - offset % 8;
      if (bits < firstBits) {
        mask = 255 << 8 - bits & 255;
        firstBits = bits;
      }
      if (offset) {
        mask = mask >> offset % 8;
      }
      var result2 = 0;
      if (offset % 8 + bits >= 8) {
        result2 = callback(0, inv(data[offsetBytes]) & mask, firstBits);
      }
      var bytes = bits + offset >> 3;
      for (var i = offsetBytes + 1; i < bytes; i++) {
        result2 = callback(result2, inv(data[i]), 8);
      }
      var lastBits = (bits + offset) % 8;
      if (lastBits > 0) {
        result2 = callback(result2, inv(data[bytes]) >> 8 - lastBits, lastBits);
      }
      return result2;
    };
    var parseFloatFromBits = function(data, precisionBits, exponentBits) {
      var bias = Math.pow(2, exponentBits - 1) - 1;
      var sign2 = parseBits(data, 1);
      var exponent = parseBits(data, exponentBits, 1);
      if (exponent === 0) {
        return 0;
      }
      var precisionBitsCounter = 1;
      var parsePrecisionBits = function(lastValue, newValue, bits) {
        if (lastValue === 0) {
          lastValue = 1;
        }
        for (var i = 1; i <= bits; i++) {
          precisionBitsCounter /= 2;
          if ((newValue & 1 << bits - i) > 0) {
            lastValue += precisionBitsCounter;
          }
        }
        return lastValue;
      };
      var mantissa = parseBits(data, precisionBits, exponentBits + 1, false, parsePrecisionBits);
      if (exponent == Math.pow(2, exponentBits + 1) - 1) {
        if (mantissa === 0) {
          return sign2 === 0 ? Infinity : -Infinity;
        }
        return NaN;
      }
      return (sign2 === 0 ? 1 : -1) * Math.pow(2, exponent - bias) * mantissa;
    };
    var parseInt16 = function(value2) {
      if (parseBits(value2, 1) == 1) {
        return -1 * (parseBits(value2, 15, 1, true) + 1);
      }
      return parseBits(value2, 15, 1);
    };
    var parseInt32 = function(value2) {
      if (parseBits(value2, 1) == 1) {
        return -1 * (parseBits(value2, 31, 1, true) + 1);
      }
      return parseBits(value2, 31, 1);
    };
    var parseFloat32 = function(value2) {
      return parseFloatFromBits(value2, 23, 8);
    };
    var parseFloat64 = function(value2) {
      return parseFloatFromBits(value2, 52, 11);
    };
    var parseNumeric = function(value2) {
      var sign2 = parseBits(value2, 16, 32);
      if (sign2 == 49152) {
        return NaN;
      }
      var weight = Math.pow(1e4, parseBits(value2, 16, 16));
      var result2 = 0;
      var digits = [];
      var ndigits = parseBits(value2, 16);
      for (var i = 0; i < ndigits; i++) {
        result2 += parseBits(value2, 16, 64 + 16 * i) * weight;
        weight /= 1e4;
      }
      var scale = Math.pow(10, parseBits(value2, 16, 48));
      return (sign2 === 0 ? 1 : -1) * Math.round(result2 * scale) / scale;
    };
    var parseDate = function(isUTC, value2) {
      var sign2 = parseBits(value2, 1);
      var rawValue = parseBits(value2, 63, 1);
      var result2 = new Date((sign2 === 0 ? 1 : -1) * rawValue / 1e3 + 9466848e5);
      if (!isUTC) {
        result2.setTime(result2.getTime() + result2.getTimezoneOffset() * 6e4);
      }
      result2.usec = rawValue % 1e3;
      result2.getMicroSeconds = function() {
        return this.usec;
      };
      result2.setMicroSeconds = function(value3) {
        this.usec = value3;
      };
      result2.getUTCMicroSeconds = function() {
        return this.usec;
      };
      return result2;
    };
    var parseArray = function(value2) {
      var dim = parseBits(value2, 32);
      var flags = parseBits(value2, 32, 32);
      var elementType = parseBits(value2, 32, 64);
      var offset = 96;
      var dims = [];
      for (var i = 0; i < dim; i++) {
        dims[i] = parseBits(value2, 32, offset);
        offset += 32;
        offset += 32;
      }
      var parseElement = function(elementType2) {
        var length = parseBits(value2, 32, offset);
        offset += 32;
        if (length == 4294967295) {
          return null;
        }
        var result2;
        if (elementType2 == 23 || elementType2 == 20) {
          result2 = parseBits(value2, length * 8, offset);
          offset += length * 8;
          return result2;
        } else if (elementType2 == 25) {
          result2 = value2.toString(this.encoding, offset >> 3, (offset += length << 3) >> 3);
          return result2;
        } else {
          console.log("ERROR: ElementType not implemented: " + elementType2);
        }
      };
      var parse = function(dimension, elementType2) {
        var array = [];
        var i2;
        if (dimension.length > 1) {
          var count = dimension.shift();
          for (i2 = 0; i2 < count; i2++) {
            array[i2] = parse(dimension, elementType2);
          }
          dimension.unshift(count);
        } else {
          for (i2 = 0; i2 < dimension[0]; i2++) {
            array[i2] = parseElement(elementType2);
          }
        }
        return array;
      };
      return parse(dims, elementType);
    };
    var parseText = function(value2) {
      return value2.toString("utf8");
    };
    var parseBool = function(value2) {
      if (value2 === null)
        return null;
      return parseBits(value2, 8) > 0;
    };
    var init = function(register) {
      register(20, parseInt64);
      register(21, parseInt16);
      register(23, parseInt32);
      register(26, parseInt32);
      register(1700, parseNumeric);
      register(700, parseFloat32);
      register(701, parseFloat64);
      register(16, parseBool);
      register(1114, parseDate.bind(null, false));
      register(1184, parseDate.bind(null, true));
      register(1e3, parseArray);
      register(1007, parseArray);
      register(1016, parseArray);
      register(1008, parseArray);
      register(1009, parseArray);
      register(25, parseText);
    };
    module2.exports = {
      init
    };
  }
});

// node_modules/pg-types/lib/builtins.js
var require_builtins = __commonJS({
  "node_modules/pg-types/lib/builtins.js"(exports2, module2) {
    module2.exports = {
      BOOL: 16,
      BYTEA: 17,
      CHAR: 18,
      INT8: 20,
      INT2: 21,
      INT4: 23,
      REGPROC: 24,
      TEXT: 25,
      OID: 26,
      TID: 27,
      XID: 28,
      CID: 29,
      JSON: 114,
      XML: 142,
      PG_NODE_TREE: 194,
      SMGR: 210,
      PATH: 602,
      POLYGON: 604,
      CIDR: 650,
      FLOAT4: 700,
      FLOAT8: 701,
      ABSTIME: 702,
      RELTIME: 703,
      TINTERVAL: 704,
      CIRCLE: 718,
      MACADDR8: 774,
      MONEY: 790,
      MACADDR: 829,
      INET: 869,
      ACLITEM: 1033,
      BPCHAR: 1042,
      VARCHAR: 1043,
      DATE: 1082,
      TIME: 1083,
      TIMESTAMP: 1114,
      TIMESTAMPTZ: 1184,
      INTERVAL: 1186,
      TIMETZ: 1266,
      BIT: 1560,
      VARBIT: 1562,
      NUMERIC: 1700,
      REFCURSOR: 1790,
      REGPROCEDURE: 2202,
      REGOPER: 2203,
      REGOPERATOR: 2204,
      REGCLASS: 2205,
      REGTYPE: 2206,
      UUID: 2950,
      TXID_SNAPSHOT: 2970,
      PG_LSN: 3220,
      PG_NDISTINCT: 3361,
      PG_DEPENDENCIES: 3402,
      TSVECTOR: 3614,
      TSQUERY: 3615,
      GTSVECTOR: 3642,
      REGCONFIG: 3734,
      REGDICTIONARY: 3769,
      JSONB: 3802,
      REGNAMESPACE: 4089,
      REGROLE: 4096
    };
  }
});

// node_modules/pg-types/index.js
var require_pg_types = __commonJS({
  "node_modules/pg-types/index.js"(exports2) {
    var textParsers = require_textParsers();
    var binaryParsers = require_binaryParsers();
    var arrayParser = require_arrayParser();
    var builtinTypes = require_builtins();
    exports2.getTypeParser = getTypeParser;
    exports2.setTypeParser = setTypeParser;
    exports2.arrayParser = arrayParser;
    exports2.builtins = builtinTypes;
    var typeParsers = {
      text: {},
      binary: {}
    };
    function noParse(val) {
      return String(val);
    }
    function getTypeParser(oid, format) {
      format = format || "text";
      if (!typeParsers[format]) {
        return noParse;
      }
      return typeParsers[format][oid] || noParse;
    }
    function setTypeParser(oid, format, parseFn) {
      if (typeof format == "function") {
        parseFn = format;
        format = "text";
      }
      typeParsers[format][oid] = parseFn;
    }
    textParsers.init(function(oid, converter) {
      typeParsers.text[oid] = converter;
    });
    binaryParsers.init(function(oid, converter) {
      typeParsers.binary[oid] = converter;
    });
  }
});

// node_modules/pg/lib/defaults.js
var require_defaults = __commonJS({
  "node_modules/pg/lib/defaults.js"(exports2, module2) {
    "use strict";
    var user;
    try {
      user = process.platform === "win32" ? process.env.USERNAME : process.env.USER;
    } catch {
    }
    module2.exports = {
      // database host. defaults to localhost
      host: "localhost",
      // database user's name
      user,
      // name of database to connect
      database: void 0,
      // database user's password
      password: null,
      // a Postgres connection string to be used instead of setting individual connection items
      // NOTE:  Setting this value will cause it to override any other value (such as database or user) defined
      // in the defaults object.
      connectionString: void 0,
      // database port
      port: 5432,
      // number of rows to return at a time from a prepared statement's
      // portal. 0 will return all rows at once
      rows: 0,
      // binary result mode
      binary: false,
      // Connection pool options - see https://github.com/brianc/node-pg-pool
      // number of connections to use in connection pool
      // 0 will disable connection pooling
      max: 10,
      // max milliseconds a client can go unused before it is removed
      // from the pool and destroyed
      idleTimeoutMillis: 3e4,
      client_encoding: "",
      ssl: false,
      // SSL negotiation style: 'postgres' (traditional SSLRequest) or 'direct'
      sslnegotiation: void 0,
      application_name: void 0,
      fallback_application_name: void 0,
      options: void 0,
      parseInputDatesAsUTC: false,
      // max milliseconds any query using this connection will execute for before timing out in error.
      // false=unlimited
      statement_timeout: false,
      // Abort any statement that waits longer than the specified duration in milliseconds while attempting to acquire a lock.
      // false=unlimited
      lock_timeout: false,
      // Terminate any session with an open transaction that has been idle for longer than the specified duration in milliseconds
      // false=unlimited
      idle_in_transaction_session_timeout: false,
      // max milliseconds to wait for query to complete (client side)
      query_timeout: false,
      connect_timeout: 0,
      keepalives: 1,
      keepalives_idle: 0
    };
    var pgTypes = require_pg_types();
    var parseBigInteger = pgTypes.getTypeParser(20, "text");
    var parseBigIntegerArray = pgTypes.getTypeParser(1016, "text");
    module2.exports.__defineSetter__("parseInt8", function(val) {
      pgTypes.setTypeParser(20, "text", val ? pgTypes.getTypeParser(23, "text") : parseBigInteger);
      pgTypes.setTypeParser(1016, "text", val ? pgTypes.getTypeParser(1007, "text") : parseBigIntegerArray);
    });
  }
});

// node_modules/pg/lib/utils.js
var require_utils = __commonJS({
  "node_modules/pg/lib/utils.js"(exports2, module2) {
    "use strict";
    var defaults2 = require_defaults();
    var nodeUtils = require("util");
    var { isDate } = require("util/types");
    var invalidDateDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Sending an invalid date to Postgres is deprecated and will throw an error in the next major version of pg. Ensure any Date object passed as a query parameter is valid.",
      "PG_INVALID_DATE"
    );
    function escapeElement(elementRepresentation) {
      const escaped = elementRepresentation.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return '"' + escaped + '"';
    }
    function arrayString(val) {
      let result2 = "{";
      for (let i = 0; i < val.length; i++) {
        if (i > 0) {
          result2 += ",";
        }
        let item = val[i];
        if (item == null) {
          result2 += "NULL";
        } else if (Array.isArray(item)) {
          result2 += arrayString(item);
        } else if (ArrayBuffer.isView(item)) {
          if (!(item instanceof Buffer)) {
            item = Buffer.from(item.buffer, item.byteOffset, item.byteLength);
          }
          result2 += "\\\\x" + item.toString("hex");
        } else {
          result2 += escapeElement(prepareValue(item));
        }
      }
      result2 += "}";
      return result2;
    }
    var prepareValue = function(val, seen) {
      if (val == null) {
        return null;
      }
      if (typeof val === "object") {
        if (val instanceof Buffer) {
          return val;
        }
        if (ArrayBuffer.isView(val)) {
          return Buffer.from(val.buffer, val.byteOffset, val.byteLength);
        }
        if (isDate(val)) {
          if (isNaN(val.getTime())) {
            invalidDateDeprecationNotice();
          }
          if (defaults2.parseInputDatesAsUTC) {
            return dateToStringUTC(val);
          } else {
            return dateToString(val);
          }
        }
        if (Array.isArray(val)) {
          return arrayString(val);
        }
        return prepareObject(val, seen);
      }
      return val.toString();
    };
    function prepareObject(val, seen) {
      if (val && typeof val.toPostgres === "function") {
        seen = seen || [];
        if (seen.indexOf(val) !== -1) {
          throw new Error('circular reference detected while preparing "' + val + '" for query');
        }
        seen.push(val);
        return prepareValue(val.toPostgres(prepareValue), seen);
      }
      return JSON.stringify(val);
    }
    function dateToString(date) {
      let offset = -date.getTimezoneOffset();
      let year = date.getFullYear();
      const isBCYear = year < 1;
      if (isBCYear)
        year = Math.abs(year) + 1;
      let ret = String(year).padStart(4, "0") + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0") + "T" + String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0") + ":" + String(date.getSeconds()).padStart(2, "0") + "." + String(date.getMilliseconds()).padStart(3, "0");
      if (offset < 0) {
        ret += "-";
        offset *= -1;
      } else {
        ret += "+";
      }
      ret += String(Math.floor(offset / 60)).padStart(2, "0") + ":" + String(offset % 60).padStart(2, "0");
      if (isBCYear)
        ret += " BC";
      return ret;
    }
    function dateToStringUTC(date) {
      let year = date.getUTCFullYear();
      const isBCYear = year < 1;
      if (isBCYear)
        year = Math.abs(year) + 1;
      let ret = String(year).padStart(4, "0") + "-" + String(date.getUTCMonth() + 1).padStart(2, "0") + "-" + String(date.getUTCDate()).padStart(2, "0") + "T" + String(date.getUTCHours()).padStart(2, "0") + ":" + String(date.getUTCMinutes()).padStart(2, "0") + ":" + String(date.getUTCSeconds()).padStart(2, "0") + "." + String(date.getUTCMilliseconds()).padStart(3, "0");
      ret += "+00:00";
      if (isBCYear)
        ret += " BC";
      return ret;
    }
    function normalizeQueryConfig(config, values, callback) {
      config = typeof config === "string" ? { text: config } : cloneQueryConfig(config);
      if (values) {
        if (typeof values === "function") {
          config.callback = values;
        } else {
          config.values = values;
        }
      }
      if (callback) {
        config.callback = callback;
      }
      return config;
    }
    function cloneQueryConfig(config) {
      if (config == null) {
        return config;
      }
      return Object.defineProperties(Object.create(Object.getPrototypeOf(config)), Object.getOwnPropertyDescriptors(config));
    }
    var escapeIdentifier2 = function(str) {
      return '"' + str.replace(/"/g, '""') + '"';
    };
    var escapeLiteral2 = function(str) {
      let hasBackslash = false;
      let escaped = "'";
      if (str == null) {
        return "''";
      }
      if (typeof str !== "string") {
        return "''";
      }
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (c === "'") {
          escaped += c + c;
        } else if (c === "\\") {
          escaped += c + c;
          hasBackslash = true;
        } else {
          escaped += c;
        }
      }
      escaped += "'";
      if (hasBackslash === true) {
        escaped = " E" + escaped;
      }
      return escaped;
    };
    module2.exports = {
      prepareValue: function prepareValueWrapper(value2) {
        return prepareValue(value2);
      },
      normalizeQueryConfig,
      escapeIdentifier: escapeIdentifier2,
      escapeLiteral: escapeLiteral2
    };
  }
});

// node_modules/pg/lib/crypto/utils.js
var require_utils2 = __commonJS({
  "node_modules/pg/lib/crypto/utils.js"(exports2, module2) {
    var nodeCrypto = require("crypto");
    module2.exports = {
      postgresMd5PasswordHash,
      randomBytes: randomBytes3,
      deriveKey,
      sha256,
      hashByName,
      hmacSha256,
      md5
    };
    var webCrypto = nodeCrypto.webcrypto || globalThis.crypto;
    var subtleCrypto = webCrypto.subtle;
    var textEncoder = new TextEncoder();
    function randomBytes3(length) {
      return webCrypto.getRandomValues(Buffer.alloc(length));
    }
    async function md5(string2) {
      try {
        return nodeCrypto.createHash("md5").update(string2, "utf-8").digest("hex");
      } catch (e) {
        const data = typeof string2 === "string" ? textEncoder.encode(string2) : string2;
        const hash = await subtleCrypto.digest("MD5", data);
        return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
      }
    }
    async function postgresMd5PasswordHash(user, password, salt) {
      const inner = await md5(password + user);
      const outer = await md5(Buffer.concat([Buffer.from(inner), salt]));
      return "md5" + outer;
    }
    async function sha256(text9) {
      return await subtleCrypto.digest("SHA-256", text9);
    }
    async function hashByName(hashName, text9) {
      return await subtleCrypto.digest(hashName, text9);
    }
    async function hmacSha256(keyBuffer, msg) {
      const key = await subtleCrypto.importKey("raw", keyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return await subtleCrypto.sign("HMAC", key, textEncoder.encode(msg));
    }
    async function deriveKey(password, salt, iterations) {
      const key = await subtleCrypto.importKey("raw", textEncoder.encode(password), "PBKDF2", false, ["deriveBits"]);
      const params = { name: "PBKDF2", hash: "SHA-256", salt, iterations };
      return await subtleCrypto.deriveBits(params, key, 32 * 8, ["deriveBits"]);
    }
  }
});

// node_modules/pg/lib/crypto/cert-signatures.js
var require_cert_signatures = __commonJS({
  "node_modules/pg/lib/crypto/cert-signatures.js"(exports2, module2) {
    function x509Error(msg, cert) {
      return new Error("SASL channel binding: " + msg + " when parsing public certificate " + cert.toString("base64"));
    }
    function readASN1Length(data, index) {
      let length = data[index++];
      if (length < 128)
        return { length, index };
      const lengthBytes = length & 127;
      if (lengthBytes > 4)
        throw x509Error("bad length", data);
      length = 0;
      for (let i = 0; i < lengthBytes; i++) {
        length = length << 8 | data[index++];
      }
      return { length, index };
    }
    function readASN1OID(data, index) {
      if (data[index++] !== 6)
        throw x509Error("non-OID data", data);
      const { length: OIDLength, index: indexAfterOIDLength } = readASN1Length(data, index);
      index = indexAfterOIDLength;
      const lastIndex = index + OIDLength;
      const byte1 = data[index++];
      let oid = (byte1 / 40 >> 0) + "." + byte1 % 40;
      while (index < lastIndex) {
        let value2 = 0;
        while (index < lastIndex) {
          const nextByte = data[index++];
          value2 = value2 << 7 | nextByte & 127;
          if (nextByte < 128)
            break;
        }
        oid += "." + value2;
      }
      return { oid, index };
    }
    function expectASN1Seq(data, index) {
      if (data[index++] !== 48)
        throw x509Error("non-sequence data", data);
      return readASN1Length(data, index);
    }
    function signatureAlgorithmHashFromCertificate(data, index) {
      if (index === void 0)
        index = 0;
      index = expectASN1Seq(data, index).index;
      const { length: certInfoLength, index: indexAfterCertInfoLength } = expectASN1Seq(data, index);
      index = indexAfterCertInfoLength + certInfoLength;
      index = expectASN1Seq(data, index).index;
      const { oid, index: indexAfterOID } = readASN1OID(data, index);
      switch (oid) {
        case "1.2.840.113549.1.1.4":
          return "MD5";
        case "1.2.840.113549.1.1.5":
          return "SHA-1";
        case "1.2.840.113549.1.1.11":
          return "SHA-256";
        case "1.2.840.113549.1.1.12":
          return "SHA-384";
        case "1.2.840.113549.1.1.13":
          return "SHA-512";
        case "1.2.840.113549.1.1.14":
          return "SHA-224";
        case "1.2.840.113549.1.1.15":
          return "SHA512-224";
        case "1.2.840.113549.1.1.16":
          return "SHA512-256";
        case "1.2.840.10045.4.1":
          return "SHA-1";
        case "1.2.840.10045.4.3.1":
          return "SHA-224";
        case "1.2.840.10045.4.3.2":
          return "SHA-256";
        case "1.2.840.10045.4.3.3":
          return "SHA-384";
        case "1.2.840.10045.4.3.4":
          return "SHA-512";
        case "1.2.840.113549.1.1.10": {
          index = indexAfterOID;
          index = expectASN1Seq(data, index).index;
          if (data[index++] !== 160)
            throw x509Error("non-tag data", data);
          index = readASN1Length(data, index).index;
          index = expectASN1Seq(data, index).index;
          const { oid: hashOID } = readASN1OID(data, index);
          switch (hashOID) {
            case "1.2.840.113549.2.5":
              return "MD5";
            case "1.3.14.3.2.26":
              return "SHA-1";
            case "2.16.840.1.101.3.4.2.1":
              return "SHA-256";
            case "2.16.840.1.101.3.4.2.2":
              return "SHA-384";
            case "2.16.840.1.101.3.4.2.3":
              return "SHA-512";
          }
          throw x509Error("unknown hash OID " + hashOID, data);
        }
        case "1.3.101.110":
        case "1.3.101.112":
          return "SHA-512";
        case "1.3.101.111":
        case "1.3.101.113":
          throw x509Error("Ed448 certificate channel binding is not currently supported by Postgres");
      }
      throw x509Error("unknown OID " + oid, data);
    }
    module2.exports = { signatureAlgorithmHashFromCertificate };
  }
});

// node_modules/pg/lib/crypto/sasl.js
var require_sasl = __commonJS({
  "node_modules/pg/lib/crypto/sasl.js"(exports2, module2) {
    "use strict";
    var crypto = require_utils2();
    var { signatureAlgorithmHashFromCertificate } = require_cert_signatures();
    function saslprep(password) {
      const nonAsciiSpace = /[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g;
      const mappedToNothing = /[\u00AD\u034F\u1806\u180B\u180C\u180D\u200C\u200D\u2060\uFE00-\uFE0F\uFEFF]/g;
      return password.replace(nonAsciiSpace, " ").replace(mappedToNothing, "").normalize("NFKC");
    }
    var DEFAULT_MAX_SCRAM_ITERATIONS = 1e5;
    function startSession(mechanisms, stream, scramMaxIterations = DEFAULT_MAX_SCRAM_ITERATIONS) {
      const candidates = ["SCRAM-SHA-256"];
      if (stream)
        candidates.unshift("SCRAM-SHA-256-PLUS");
      const mechanism = candidates.find((candidate) => mechanisms.includes(candidate));
      if (!mechanism) {
        throw new Error("SASL: Only mechanism(s) " + candidates.join(" and ") + " are supported");
      }
      if (mechanism === "SCRAM-SHA-256-PLUS" && typeof stream.getPeerCertificate !== "function") {
        throw new Error("SASL: Mechanism SCRAM-SHA-256-PLUS requires a certificate");
      }
      const clientNonce = crypto.randomBytes(18).toString("base64");
      const gs2Header = mechanism === "SCRAM-SHA-256-PLUS" ? "p=tls-server-end-point" : stream ? "y" : "n";
      return {
        mechanism,
        clientNonce,
        response: gs2Header + ",,n=*,r=" + clientNonce,
        message: "SASLInitialResponse",
        scramMaxIterations
      };
    }
    async function continueSession(session, password, serverData, stream) {
      if (session.message !== "SASLInitialResponse") {
        throw new Error("SASL: Last message was not SASLInitialResponse");
      }
      if (typeof password !== "string") {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string");
      }
      if (password === "") {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a non-empty string");
      }
      if (typeof serverData !== "string") {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: serverData must be a string");
      }
      const sv = parseServerFirstMessage(serverData);
      if (!sv.nonce.startsWith(session.clientNonce)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce does not start with client nonce");
      } else if (sv.nonce.length === session.clientNonce.length) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: server nonce is too short");
      }
      const scramMaxIterations = typeof session.scramMaxIterations === "number" ? session.scramMaxIterations : DEFAULT_MAX_SCRAM_ITERATIONS;
      if (scramMaxIterations !== 0 && sv.iteration > scramMaxIterations) {
        throw new Error(
          "SASL: SCRAM-SERVER-FIRST-MESSAGE: iteration count " + sv.iteration + " exceeds scramMaxIterations of " + scramMaxIterations
        );
      }
      const clientFirstMessageBare = "n=*,r=" + session.clientNonce;
      const serverFirstMessage = "r=" + sv.nonce + ",s=" + sv.salt + ",i=" + sv.iteration;
      let channelBinding = stream ? "eSws" : "biws";
      if (session.mechanism === "SCRAM-SHA-256-PLUS") {
        const peerCert = stream.getPeerCertificate().raw;
        let hashName = signatureAlgorithmHashFromCertificate(peerCert);
        if (hashName === "MD5" || hashName === "SHA-1")
          hashName = "SHA-256";
        const certHash = await crypto.hashByName(hashName, peerCert);
        const bindingData = Buffer.concat([Buffer.from("p=tls-server-end-point,,"), Buffer.from(certHash)]);
        channelBinding = bindingData.toString("base64");
      }
      const clientFinalMessageWithoutProof = "c=" + channelBinding + ",r=" + sv.nonce;
      const authMessage = clientFirstMessageBare + "," + serverFirstMessage + "," + clientFinalMessageWithoutProof;
      const saltBytes = Buffer.from(sv.salt, "base64");
      const saltedPassword = await crypto.deriveKey(saslprep(password), saltBytes, sv.iteration);
      const clientKey = await crypto.hmacSha256(saltedPassword, "Client Key");
      const storedKey = await crypto.sha256(clientKey);
      const clientSignature = await crypto.hmacSha256(storedKey, authMessage);
      const clientProof = xorBuffers(Buffer.from(clientKey), Buffer.from(clientSignature)).toString("base64");
      const serverKey = await crypto.hmacSha256(saltedPassword, "Server Key");
      const serverSignatureBytes = await crypto.hmacSha256(serverKey, authMessage);
      session.message = "SASLResponse";
      session.serverSignature = Buffer.from(serverSignatureBytes).toString("base64");
      session.response = clientFinalMessageWithoutProof + ",p=" + clientProof;
    }
    function finalizeSession(session, serverData) {
      if (session.message !== "SASLResponse") {
        throw new Error("SASL: Last message was not SASLResponse");
      }
      if (typeof serverData !== "string") {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: serverData must be a string");
      }
      const { serverSignature } = parseServerFinalMessage(serverData);
      if (serverSignature !== session.serverSignature) {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature does not match");
      }
    }
    function isPrintableChars(text9) {
      if (typeof text9 !== "string") {
        throw new TypeError("SASL: text must be a string");
      }
      return text9.split("").map((_, i) => text9.charCodeAt(i)).every((c) => c >= 33 && c <= 43 || c >= 45 && c <= 126);
    }
    function isBase64(text9) {
      return /^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(text9);
    }
    function parseAttributePairs(text9) {
      if (typeof text9 !== "string") {
        throw new TypeError("SASL: attribute pairs text must be a string");
      }
      return new Map(
        text9.split(",").map((attrValue) => {
          if (!/^.=/.test(attrValue)) {
            throw new Error("SASL: Invalid attribute pair entry");
          }
          const name = attrValue[0];
          const value2 = attrValue.substring(2);
          return [name, value2];
        })
      );
    }
    function parseServerFirstMessage(data) {
      const attrPairs = parseAttributePairs(data);
      const nonce = attrPairs.get("r");
      if (!nonce) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: nonce missing");
      } else if (!isPrintableChars(nonce)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: nonce must only contain printable characters");
      }
      const salt = attrPairs.get("s");
      if (!salt) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: salt missing");
      } else if (!isBase64(salt)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: salt must be base64");
      }
      const iterationText = attrPairs.get("i");
      if (!iterationText) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: iteration missing");
      } else if (!/^[1-9][0-9]*$/.test(iterationText)) {
        throw new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: invalid iteration count");
      }
      const iteration = parseInt(iterationText, 10);
      return {
        nonce,
        salt,
        iteration
      };
    }
    function parseServerFinalMessage(serverData) {
      const attrPairs = parseAttributePairs(serverData);
      const error = attrPairs.get("e");
      const serverSignature = attrPairs.get("v");
      if (error) {
        throw new Error(`SASL: SCRAM-SERVER-FINAL-MESSAGE: server returned error: "${error}"`);
      }
      if (!serverSignature) {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature is missing");
      } else if (!isBase64(serverSignature)) {
        throw new Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server signature must be base64");
      }
      return {
        serverSignature
      };
    }
    function xorBuffers(a, b) {
      if (!Buffer.isBuffer(a)) {
        throw new TypeError("first argument must be a Buffer");
      }
      if (!Buffer.isBuffer(b)) {
        throw new TypeError("second argument must be a Buffer");
      }
      if (a.length !== b.length) {
        throw new Error("Buffer lengths must match");
      }
      if (a.length === 0) {
        throw new Error("Buffers cannot be empty");
      }
      return Buffer.from(a.map((_, i) => a[i] ^ b[i]));
    }
    module2.exports = {
      startSession,
      continueSession,
      finalizeSession,
      DEFAULT_MAX_SCRAM_ITERATIONS
    };
  }
});

// node_modules/pg/lib/type-overrides.js
var require_type_overrides = __commonJS({
  "node_modules/pg/lib/type-overrides.js"(exports2, module2) {
    "use strict";
    var types2 = require_pg_types();
    function TypeOverrides2(userTypes) {
      this._types = userTypes || types2;
      this.text = {};
      this.binary = {};
    }
    TypeOverrides2.prototype.getOverrides = function(format) {
      switch (format) {
        case "text":
          return this.text;
        case "binary":
          return this.binary;
        default:
          return {};
      }
    };
    TypeOverrides2.prototype.setTypeParser = function(oid, format, parseFn) {
      if (typeof format === "function") {
        parseFn = format;
        format = "text";
      }
      this.getOverrides(format)[oid] = parseFn;
    };
    TypeOverrides2.prototype.getTypeParser = function(oid, format) {
      format = format || "text";
      return this.getOverrides(format)[oid] || this._types.getTypeParser(oid, format);
    };
    module2.exports = TypeOverrides2;
  }
});

// node_modules/pg-connection-string/index.js
var require_pg_connection_string = __commonJS({
  "node_modules/pg-connection-string/index.js"(exports2, module2) {
    "use strict";
    function parse(str, options = {}) {
      if (str.charAt(0) === "/") {
        const config2 = str.split(" ");
        return { host: config2[0], database: config2[1] };
      }
      const config = /* @__PURE__ */ Object.create(null);
      let result2;
      let dummyHost = false;
      if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(str)) {
        str = encodeURI(str).replace(/%25(\d\d)/g, "%$1");
      }
      try {
        try {
          result2 = new URL(str, "postgres://base");
        } catch (e) {
          result2 = new URL(str.replace("@/", "@___DUMMY___/"), "postgres://base");
          dummyHost = true;
        }
      } catch (err) {
        err.input && (err.input = "*****REDACTED*****");
        throw err;
      }
      for (const entry of result2.searchParams.entries()) {
        config[entry[0]] = entry[1];
      }
      config.user = config.user || decodeURIComponent(result2.username);
      config.password = config.password || decodeURIComponent(result2.password);
      if (result2.protocol == "socket:") {
        config.host = decodeURI(result2.pathname);
        config.database = result2.searchParams.get("db");
        config.client_encoding = result2.searchParams.get("encoding");
        return config;
      }
      const hostname = (dummyHost ? "" : result2.hostname).replace(/^\[(.+)\]$/, "$1");
      if (!config.host) {
        config.host = decodeURIComponent(hostname);
      } else if (hostname && /^%2f/i.test(hostname)) {
        result2.pathname = hostname + result2.pathname;
      }
      if (!config.port) {
        config.port = result2.port;
      }
      const pathname = result2.pathname.slice(1) || null;
      config.database = pathname ? decodeURI(pathname) : null;
      if (config.ssl === "true" || config.ssl === "1") {
        config.ssl = true;
      }
      if (config.ssl === "0") {
        config.ssl = false;
      }
      if (config.sslcert || config.sslkey || config.sslrootcert || config.sslmode) {
        config.ssl = {};
      }
      if (config.sslnegotiation === "direct" && config.ssl === void 0) {
        config.ssl = true;
      }
      const fs = config.sslcert || config.sslkey || config.sslrootcert ? require("fs") : null;
      if (config.sslcert) {
        config.ssl.cert = fs.readFileSync(config.sslcert).toString();
      }
      if (config.sslkey) {
        config.ssl.key = fs.readFileSync(config.sslkey).toString();
      }
      if (config.sslrootcert) {
        config.ssl.ca = fs.readFileSync(config.sslrootcert).toString();
      }
      if (options.useLibpqCompat && config.uselibpqcompat) {
        throw new Error("Both useLibpqCompat and uselibpqcompat are set. Please use only one of them.");
      }
      if (config.uselibpqcompat === "true" || options.useLibpqCompat) {
        switch (config.sslmode) {
          case "disable": {
            config.ssl = false;
            break;
          }
          case "prefer": {
            config.ssl.rejectUnauthorized = false;
            break;
          }
          case "require": {
            if (config.sslrootcert) {
              config.ssl.checkServerIdentity = function() {
              };
            } else {
              config.ssl.rejectUnauthorized = false;
            }
            break;
          }
          case "verify-ca": {
            if (!config.ssl.ca) {
              throw new Error(
                "SECURITY WARNING: Using sslmode=verify-ca requires specifying a CA with sslrootcert. If a public CA is used, verify-ca allows connections to a server that somebody else may have registered with the CA, making you vulnerable to Man-in-the-Middle attacks. Either specify a custom CA certificate with sslrootcert parameter or use sslmode=verify-full for proper security."
              );
            }
            config.ssl.checkServerIdentity = function() {
            };
            break;
          }
          case "verify-full": {
            break;
          }
        }
      } else {
        switch (config.sslmode) {
          case "disable": {
            config.ssl = false;
            break;
          }
          case "prefer":
          case "require":
          case "verify-ca":
          case "verify-full": {
            if (config.sslmode !== "verify-full") {
              deprecatedSslModeWarning(config.sslmode);
            }
            break;
          }
          case "no-verify": {
            config.ssl.rejectUnauthorized = false;
            break;
          }
        }
      }
      return config;
    }
    function toConnectionOptions(sslConfig) {
      const connectionOptions = Object.entries(sslConfig).reduce((c, [key, value2]) => {
        if (value2 !== void 0 && value2 !== null) {
          c[key] = value2;
        }
        return c;
      }, /* @__PURE__ */ Object.create(null));
      return connectionOptions;
    }
    function toClientConfig(config) {
      const poolConfig = Object.entries(config).reduce((c, [key, value2]) => {
        if (key === "ssl") {
          const sslConfig = value2;
          if (typeof sslConfig === "boolean") {
            c[key] = sslConfig;
          }
          if (typeof sslConfig === "object") {
            c[key] = toConnectionOptions(sslConfig);
          }
        } else if (value2 !== void 0 && value2 !== null) {
          if (key === "port") {
            if (value2 !== "") {
              const v = parseInt(value2, 10);
              if (isNaN(v)) {
                throw new Error(`Invalid ${key}: ${value2}`);
              }
              c[key] = v;
            }
          } else {
            c[key] = value2;
          }
        }
        return c;
      }, /* @__PURE__ */ Object.create(null));
      return poolConfig;
    }
    function parseIntoClientConfig(str) {
      return toClientConfig(parse(str));
    }
    function deprecatedSslModeWarning(sslmode) {
      if (!deprecatedSslModeWarning.warned && typeof process !== "undefined" && process.emitWarning) {
        deprecatedSslModeWarning.warned = true;
        process.emitWarning(`SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.
In the next major version (pg-connection-string v3.0.0 and pg v9.0.0), these modes will adopt standard libpq semantics, which have weaker security guarantees.

To prepare for this change:
- If you want the current behavior, explicitly use 'sslmode=verify-full'
- If you want libpq compatibility now, use 'uselibpqcompat=true&sslmode=${sslmode}'

See https://www.postgresql.org/docs/current/libpq-ssl.html for libpq SSL mode definitions.`);
      }
    }
    module2.exports = parse;
    parse.parse = parse;
    parse.toClientConfig = toClientConfig;
    parse.parseIntoClientConfig = parseIntoClientConfig;
  }
});

// node_modules/pg/lib/connection-parameters.js
var require_connection_parameters = __commonJS({
  "node_modules/pg/lib/connection-parameters.js"(exports2, module2) {
    "use strict";
    var dns = require("dns");
    var defaults2 = require_defaults();
    var parse = require_pg_connection_string().parse;
    var val = function(key, config, envVar) {
      if (config[key]) {
        return config[key];
      }
      if (envVar === void 0) {
        envVar = process.env["PG" + key.toUpperCase()];
      } else if (envVar === false) {
      } else {
        envVar = process.env[envVar];
      }
      return envVar || defaults2[key];
    };
    var readSSLConfigFromEnvironment = function() {
      switch (process.env.PGSSLMODE) {
        case "disable":
          return false;
        case "prefer":
        case "require":
        case "verify-ca":
        case "verify-full":
          return true;
        case "no-verify":
          return { rejectUnauthorized: false };
      }
      return defaults2.ssl;
    };
    var quoteParamValue = function(value2) {
      return "'" + ("" + value2).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
    };
    var add = function(params, config, paramName) {
      const value2 = config[paramName];
      if (value2 !== void 0 && value2 !== null) {
        params.push(paramName + "=" + quoteParamValue(value2));
      }
    };
    var ConnectionParameters = class {
      constructor(config) {
        config = typeof config === "string" ? parse(config) : config || {};
        if (config.connectionString) {
          config = Object.assign({}, config, parse(config.connectionString));
        }
        this.user = val("user", config);
        this.database = val("database", config);
        if (this.database === void 0) {
          this.database = this.user;
        }
        this.port = parseInt(val("port", config), 10);
        this.host = val("host", config);
        Object.defineProperty(this, "password", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: val("password", config)
        });
        this.binary = val("binary", config);
        this.options = val("options", config);
        this.ssl = typeof config.ssl === "undefined" ? readSSLConfigFromEnvironment() : config.ssl;
        if (typeof this.ssl === "string") {
          if (this.ssl === "true") {
            this.ssl = true;
          }
        }
        if (this.ssl === "no-verify") {
          this.ssl = { rejectUnauthorized: false };
        }
        if (this.ssl && this.ssl.key) {
          Object.defineProperty(this.ssl, "key", {
            enumerable: false
          });
        }
        this.sslnegotiation = val("sslnegotiation", config, "PGSSLNEGOTIATION");
        if (this.sslnegotiation !== void 0 && this.sslnegotiation !== "postgres" && this.sslnegotiation !== "direct") {
          throw new Error(
            `Invalid sslnegotiation value: "${this.sslnegotiation}". Valid values are "postgres" and "direct".`
          );
        }
        if (this.sslnegotiation === "direct" && !this.ssl) {
          throw new Error("sslnegotiation=direct requires SSL to be enabled");
        }
        this.client_encoding = val("client_encoding", config);
        this.replication = val("replication", config);
        this.isDomainSocket = !(this.host || "").indexOf("/");
        this.application_name = val("application_name", config, "PGAPPNAME");
        this.fallback_application_name = val("fallback_application_name", config, false);
        this.statement_timeout = val("statement_timeout", config, false);
        this.lock_timeout = val("lock_timeout", config, false);
        this.idle_in_transaction_session_timeout = val("idle_in_transaction_session_timeout", config, false);
        this.query_timeout = val("query_timeout", config, false);
        if (config.connectionTimeoutMillis === void 0) {
          this.connect_timeout = process.env.PGCONNECT_TIMEOUT || 0;
        } else {
          this.connect_timeout = Math.floor(config.connectionTimeoutMillis / 1e3);
        }
        if (config.keepAlive === false) {
          this.keepalives = 0;
        } else if (config.keepAlive === true) {
          this.keepalives = 1;
        }
        if (typeof config.keepAliveInitialDelayMillis === "number") {
          this.keepalives_idle = Math.floor(config.keepAliveInitialDelayMillis / 1e3);
        }
      }
      getLibpqConnectionString(cb) {
        const params = [];
        add(params, this, "user");
        add(params, this, "password");
        add(params, this, "port");
        add(params, this, "application_name");
        add(params, this, "fallback_application_name");
        add(params, this, "connect_timeout");
        add(params, this, "options");
        const ssl = typeof this.ssl === "object" ? this.ssl : this.ssl ? { sslmode: this.ssl } : {};
        add(params, ssl, "sslmode");
        add(params, ssl, "sslca");
        add(params, ssl, "sslkey");
        add(params, ssl, "sslcert");
        add(params, ssl, "sslrootcert");
        add(params, this, "sslnegotiation");
        if (this.database) {
          params.push("dbname=" + quoteParamValue(this.database));
        }
        if (this.replication) {
          params.push("replication=" + quoteParamValue(this.replication));
        }
        if (this.host) {
          params.push("host=" + quoteParamValue(this.host));
        }
        if (this.isDomainSocket) {
          return cb(null, params.join(" "));
        }
        if (this.client_encoding) {
          params.push("client_encoding=" + quoteParamValue(this.client_encoding));
        }
        dns.lookup(this.host, function(err, address) {
          if (err)
            return cb(err, null);
          params.push("hostaddr=" + quoteParamValue(address));
          return cb(null, params.join(" "));
        });
      }
    };
    module2.exports = ConnectionParameters;
  }
});

// node_modules/pg/lib/result.js
var require_result = __commonJS({
  "node_modules/pg/lib/result.js"(exports2, module2) {
    "use strict";
    var types2 = require_pg_types();
    var matchRegexp = /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/;
    var Result2 = class {
      constructor(rowMode, types3) {
        this.command = null;
        this.rowCount = null;
        this.oid = null;
        this.rows = [];
        this.fields = [];
        this._parsers = void 0;
        this._types = types3;
        this.RowCtor = null;
        this.rowAsArray = rowMode === "array";
        if (this.rowAsArray) {
          this.parseRow = this._parseRowAsArray;
        }
        this._prebuiltEmptyResultObject = null;
      }
      // adds a command complete message
      addCommandComplete(msg) {
        let match;
        if (msg.text) {
          match = matchRegexp.exec(msg.text);
        } else {
          match = matchRegexp.exec(msg.command);
        }
        if (match) {
          this.command = match[1];
          if (match[3]) {
            this.oid = parseInt(match[2], 10);
            this.rowCount = parseInt(match[3], 10);
          } else if (match[2]) {
            this.rowCount = parseInt(match[2], 10);
          }
        }
      }
      _parseRowAsArray(rowData) {
        const row2 = new Array(rowData.length);
        for (let i = 0, len = rowData.length; i < len; i++) {
          const rawValue = rowData[i];
          if (rawValue !== null) {
            row2[i] = this._parsers[i](rawValue);
          } else {
            row2[i] = null;
          }
        }
        return row2;
      }
      parseRow(rowData) {
        const row2 = { ...this._prebuiltEmptyResultObject };
        for (let i = 0, len = rowData.length; i < len; i++) {
          const rawValue = rowData[i];
          const field = this.fields[i].name;
          if (rawValue !== null) {
            const v = this.fields[i].format === "binary" ? Buffer.from(rawValue) : rawValue;
            row2[field] = this._parsers[i](v);
          } else {
            row2[field] = null;
          }
        }
        return row2;
      }
      addRow(row2) {
        this.rows.push(row2);
      }
      addFields(fieldDescriptions) {
        this.fields = fieldDescriptions;
        if (this.fields.length) {
          this._parsers = new Array(fieldDescriptions.length);
        }
        const row2 = /* @__PURE__ */ Object.create(null);
        for (let i = 0; i < fieldDescriptions.length; i++) {
          const desc = fieldDescriptions[i];
          row2[desc.name] = null;
          if (this._types) {
            this._parsers[i] = this._types.getTypeParser(desc.dataTypeID, desc.format || "text");
          } else {
            this._parsers[i] = types2.getTypeParser(desc.dataTypeID, desc.format || "text");
          }
        }
        this._prebuiltEmptyResultObject = { ...row2 };
      }
    };
    module2.exports = Result2;
  }
});

// node_modules/pg/lib/query.js
var require_query = __commonJS({
  "node_modules/pg/lib/query.js"(exports2, module2) {
    "use strict";
    var { EventEmitter } = require("events");
    var Result2 = require_result();
    var utils = require_utils();
    var Query2 = class extends EventEmitter {
      constructor(config, values, callback) {
        super();
        config = utils.normalizeQueryConfig(config, values, callback);
        this.text = config.text;
        this.values = config.values;
        this.rows = config.rows;
        this.types = config.types;
        this.name = config.name;
        this.queryMode = config.queryMode;
        this.binary = config.binary;
        this.portal = config.portal || "";
        this.callback = config.callback;
        this._rowMode = config.rowMode;
        if (process.domain && config.callback) {
          this.callback = process.domain.bind(config.callback);
        }
        this._result = new Result2(this._rowMode, this.types);
        this._results = this._result;
        this._canceledDueToError = false;
      }
      requiresPreparation() {
        if (this.queryMode === "extended") {
          return true;
        }
        if (this.name) {
          return true;
        }
        if (this.rows) {
          return true;
        }
        if (!this.text) {
          return false;
        }
        if (!this.values) {
          return false;
        }
        return this.values.length > 0;
      }
      _checkForMultirow() {
        if (this._result.command) {
          if (!Array.isArray(this._results)) {
            this._results = [this._result];
          }
          this._result = new Result2(this._rowMode, this._result._types);
          this._results.push(this._result);
        }
      }
      // associates row metadata from the supplied
      // message with this query object
      // metadata used when parsing row results
      handleRowDescription(msg) {
        this._checkForMultirow();
        this._result.addFields(msg.fields);
        this._accumulateRows = this.callback || !this.listeners("row").length;
      }
      handleDataRow(msg) {
        let row2;
        if (this._canceledDueToError) {
          return;
        }
        try {
          row2 = this._result.parseRow(msg.fields);
        } catch (err) {
          this._canceledDueToError = err;
          return;
        }
        this.emit("row", row2, this._result);
        if (this._accumulateRows) {
          this._result.addRow(row2);
        }
      }
      handleCommandComplete(msg, connection) {
        this._checkForMultirow();
        this._result.addCommandComplete(msg);
        if (this.rows) {
          connection.sync();
        }
      }
      // if a named prepared statement is created with empty query text
      // the backend will send an emptyQuery message but *not* a command complete message
      // since we pipeline sync immediately after execute we don't need to do anything here
      // unless we have rows specified, in which case we did not pipeline the initial sync call
      handleEmptyQuery(connection) {
        if (this.rows) {
          connection.sync();
        }
      }
      handleError(err, connection) {
        if (this._canceledDueToError) {
          err = this._canceledDueToError;
          this._canceledDueToError = false;
        }
        if (this.callback) {
          return this.callback(err);
        }
        this.emit("error", err);
      }
      handleReadyForQuery(con) {
        if (this._canceledDueToError) {
          return this.handleError(this._canceledDueToError, con);
        }
        if (this.callback) {
          try {
            this.callback(null, this._results);
          } catch (err) {
            process.nextTick(() => {
              throw err;
            });
          }
        }
        this.emit("end", this._results);
      }
      submit(connection) {
        if (typeof this.text !== "string" && typeof this.name !== "string") {
          return new Error("A query must have either text or a name. Supplying neither is unsupported.");
        }
        const previous = connection.parsedStatements[this.name] || connection.submittedNamedStatements[this.name];
        if (this.text && previous && this.text !== previous) {
          return new Error(`Prepared statements must be unique - '${this.name}' was used for a different statement`);
        }
        if (this.values && !Array.isArray(this.values)) {
          return new Error("Query values must be an array");
        }
        if (this.requiresPreparation()) {
          connection.stream.cork && connection.stream.cork();
          try {
            this.prepare(connection);
          } finally {
            connection.stream.uncork && connection.stream.uncork();
          }
        } else {
          connection.query(this.text);
        }
        return null;
      }
      hasBeenParsed(connection) {
        return this.name && (connection.parsedStatements[this.name] !== void 0 || connection.submittedNamedStatements[this.name] !== void 0);
      }
      handlePortalSuspended(connection) {
        this._getRows(connection, this.rows);
      }
      _getRows(connection, rows) {
        connection.execute({
          portal: this.portal,
          rows
        });
        if (!rows) {
          connection.sync();
        } else {
          connection.flush();
        }
      }
      // http://developer.postgresql.org/pgdocs/postgres/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY
      prepare(connection) {
        if (!this.hasBeenParsed(connection)) {
          connection.parse({
            text: this.text,
            name: this.name,
            types: this.types
          });
          if (this.name) {
            connection.submittedNamedStatements[this.name] = this.text;
          }
        }
        try {
          connection.bind({
            portal: this.portal,
            statement: this.name,
            values: this.values,
            binary: this.binary,
            valueMapper: utils.prepareValue
          });
        } catch (err) {
          connection.close({ type: "S", name: this.name });
          connection.sync();
          this.handleError(err, connection);
          return;
        }
        connection.describe({
          type: "P",
          name: this.portal || ""
        });
        this._getRows(connection, this.rows);
      }
      handleCopyInResponse(connection) {
        connection.sendCopyFail("No source stream defined");
      }
      handleCopyData(msg, connection) {
      }
    };
    module2.exports = Query2;
  }
});

// node_modules/pg-protocol/dist/messages.js
var require_messages = __commonJS({
  "node_modules/pg-protocol/dist/messages.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.NoticeMessage = exports2.DataRowMessage = exports2.CommandCompleteMessage = exports2.ReadyForQueryMessage = exports2.NotificationResponseMessage = exports2.BackendKeyDataMessage = exports2.AuthenticationMD5Password = exports2.ParameterStatusMessage = exports2.ParameterDescriptionMessage = exports2.RowDescriptionMessage = exports2.Field = exports2.CopyResponse = exports2.CopyDataMessage = exports2.DatabaseError = exports2.copyDone = exports2.emptyQuery = exports2.replicationStart = exports2.portalSuspended = exports2.noData = exports2.closeComplete = exports2.bindComplete = exports2.parseComplete = void 0;
    exports2.parseComplete = {
      name: "parseComplete",
      length: 5
    };
    exports2.bindComplete = {
      name: "bindComplete",
      length: 5
    };
    exports2.closeComplete = {
      name: "closeComplete",
      length: 5
    };
    exports2.noData = {
      name: "noData",
      length: 5
    };
    exports2.portalSuspended = {
      name: "portalSuspended",
      length: 5
    };
    exports2.replicationStart = {
      name: "replicationStart",
      length: 4
    };
    exports2.emptyQuery = {
      name: "emptyQuery",
      length: 4
    };
    exports2.copyDone = {
      name: "copyDone",
      length: 4
    };
    var DatabaseError2 = class extends Error {
      constructor(message, length, name) {
        super(message);
        this.length = length;
        this.name = name;
      }
    };
    exports2.DatabaseError = DatabaseError2;
    var CopyDataMessage = class {
      constructor(length, chunk) {
        this.length = length;
        this.chunk = chunk;
        this.name = "copyData";
      }
    };
    exports2.CopyDataMessage = CopyDataMessage;
    var CopyResponse = class {
      constructor(length, name, binary, columnCount) {
        this.length = length;
        this.name = name;
        this.binary = binary;
        this.columnTypes = new Array(columnCount);
      }
    };
    exports2.CopyResponse = CopyResponse;
    var Field = class {
      constructor(name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, format) {
        this.name = name;
        this.tableID = tableID;
        this.columnID = columnID;
        this.dataTypeID = dataTypeID;
        this.dataTypeSize = dataTypeSize;
        this.dataTypeModifier = dataTypeModifier;
        this.format = format;
      }
    };
    exports2.Field = Field;
    var RowDescriptionMessage = class {
      constructor(length, fieldCount) {
        this.length = length;
        this.fieldCount = fieldCount;
        this.name = "rowDescription";
        this.fields = new Array(this.fieldCount);
      }
    };
    exports2.RowDescriptionMessage = RowDescriptionMessage;
    var ParameterDescriptionMessage = class {
      constructor(length, parameterCount) {
        this.length = length;
        this.parameterCount = parameterCount;
        this.name = "parameterDescription";
        this.dataTypeIDs = new Array(this.parameterCount);
      }
    };
    exports2.ParameterDescriptionMessage = ParameterDescriptionMessage;
    var ParameterStatusMessage = class {
      constructor(length, parameterName, parameterValue) {
        this.length = length;
        this.parameterName = parameterName;
        this.parameterValue = parameterValue;
        this.name = "parameterStatus";
      }
    };
    exports2.ParameterStatusMessage = ParameterStatusMessage;
    var AuthenticationMD5Password = class {
      constructor(length, salt) {
        this.length = length;
        this.salt = salt;
        this.name = "authenticationMD5Password";
      }
    };
    exports2.AuthenticationMD5Password = AuthenticationMD5Password;
    var BackendKeyDataMessage = class {
      constructor(length, processID, secretKey) {
        this.length = length;
        this.processID = processID;
        this.secretKey = secretKey;
        this.name = "backendKeyData";
      }
    };
    exports2.BackendKeyDataMessage = BackendKeyDataMessage;
    var NotificationResponseMessage = class {
      constructor(length, processId, channel, payload) {
        this.length = length;
        this.processId = processId;
        this.channel = channel;
        this.payload = payload;
        this.name = "notification";
      }
    };
    exports2.NotificationResponseMessage = NotificationResponseMessage;
    var ReadyForQueryMessage = class {
      constructor(length, status) {
        this.length = length;
        this.status = status;
        this.name = "readyForQuery";
      }
    };
    exports2.ReadyForQueryMessage = ReadyForQueryMessage;
    var CommandCompleteMessage = class {
      constructor(length, text9) {
        this.length = length;
        this.text = text9;
        this.name = "commandComplete";
      }
    };
    exports2.CommandCompleteMessage = CommandCompleteMessage;
    var DataRowMessage = class {
      constructor(length, fields) {
        this.length = length;
        this.fields = fields;
        this.name = "dataRow";
        this.fieldCount = fields.length;
      }
    };
    exports2.DataRowMessage = DataRowMessage;
    var NoticeMessage = class {
      constructor(length, message) {
        this.length = length;
        this.message = message;
        this.name = "notice";
      }
    };
    exports2.NoticeMessage = NoticeMessage;
  }
});

// node_modules/pg-protocol/dist/buffer-writer.js
var require_buffer_writer = __commonJS({
  "node_modules/pg-protocol/dist/buffer-writer.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Writer = void 0;
    var Writer = class {
      constructor(size = 256) {
        this.size = size;
        this.offset = 5;
        this.headerPosition = 0;
        this.buffer = Buffer.allocUnsafe(size);
      }
      ensure(size) {
        const remaining = this.buffer.length - this.offset;
        if (remaining < size) {
          const oldBuffer = this.buffer;
          const newSize = oldBuffer.length + (oldBuffer.length >> 1) + size;
          this.buffer = Buffer.allocUnsafe(newSize);
          oldBuffer.copy(this.buffer, 0, 0, this.offset);
        }
      }
      addInt32(num) {
        this.ensure(4);
        this.buffer[this.offset++] = num >>> 24 & 255;
        this.buffer[this.offset++] = num >>> 16 & 255;
        this.buffer[this.offset++] = num >>> 8 & 255;
        this.buffer[this.offset++] = num >>> 0 & 255;
        return this;
      }
      addInt16(num) {
        this.ensure(2);
        this.buffer[this.offset++] = num >>> 8 & 255;
        this.buffer[this.offset++] = num >>> 0 & 255;
        return this;
      }
      addCString(string2) {
        if (!string2) {
          this.ensure(1);
        } else {
          const len = Buffer.byteLength(string2);
          this.ensure(len + 1);
          this.buffer.write(string2, this.offset, "utf-8");
          this.offset += len;
        }
        this.buffer[this.offset++] = 0;
        return this;
      }
      addString(string2 = "") {
        const len = Buffer.byteLength(string2);
        this.ensure(len);
        this.buffer.write(string2, this.offset);
        this.offset += len;
        return this;
      }
      // Write an Int32 byte-length prefix immediately followed by the string's UTF-8
      // bytes. Postgres' Bind wire format prefixes every parameter with its length,
      // and doing it in one method computes Buffer.byteLength ONCE — the previous
      // `addInt32(Buffer.byteLength(s)).addString(s)` pairing scanned the string
      // three times (byteLength for the prefix, byteLength again inside addString,
      // then the encode), which is costly for large text parameters.
      addInt32PrefixedString(string2) {
        const len = Buffer.byteLength(string2);
        this.ensure(4 + len);
        const buffer = this.buffer;
        let offset = this.offset;
        buffer[offset++] = len >>> 24 & 255;
        buffer[offset++] = len >>> 16 & 255;
        buffer[offset++] = len >>> 8 & 255;
        buffer[offset++] = len >>> 0 & 255;
        buffer.write(string2, offset, "utf-8");
        this.offset = offset + len;
        return this;
      }
      add(otherBuffer) {
        this.ensure(otherBuffer.length);
        otherBuffer.copy(this.buffer, this.offset);
        this.offset += otherBuffer.length;
        return this;
      }
      /**
       * Appends an uninitialized block of {@link size} bytes to the buffer and returns its offset.
       */
      reserveUnsafe(size) {
        const offset = this.offset;
        this.ensure(size);
        this.offset += size;
        return offset;
      }
      join(code2) {
        if (code2) {
          this.buffer[this.headerPosition] = code2;
          const length = this.offset - (this.headerPosition + 1);
          this.buffer.writeInt32BE(length, this.headerPosition + 1);
        }
        return this.buffer.slice(code2 ? 0 : 5, this.offset);
      }
      flush(code2) {
        const result2 = this.join(code2);
        this.offset = 5;
        this.headerPosition = 0;
        this.buffer = Buffer.allocUnsafe(this.size);
        return result2;
      }
      clear() {
        this.offset = 5;
        this.headerPosition = 0;
      }
    };
    exports2.Writer = Writer;
  }
});

// node_modules/pg-protocol/dist/serializer.js
var require_serializer = __commonJS({
  "node_modules/pg-protocol/dist/serializer.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.serialize = void 0;
    var buffer_writer_1 = require_buffer_writer();
    var writer = new buffer_writer_1.Writer();
    var startup = (opts) => {
      writer.addInt16(3).addInt16(0);
      for (const key of Object.keys(opts)) {
        writer.addCString(key).addCString(opts[key]);
      }
      writer.addCString("client_encoding").addCString("UTF8");
      const bodyBuffer = writer.addCString("").flush();
      const length = bodyBuffer.length + 4;
      return new buffer_writer_1.Writer().addInt32(length).add(bodyBuffer).flush();
    };
    var requestSsl = () => {
      const response = Buffer.allocUnsafe(8);
      response.writeInt32BE(8, 0);
      response.writeInt32BE(80877103, 4);
      return response;
    };
    var password = (password2) => {
      return writer.addCString(password2).flush(
        112
        /* code.startup */
      );
    };
    var sendSASLInitialResponseMessage = function(mechanism, initialResponse) {
      writer.addCString(mechanism).addInt32PrefixedString(initialResponse);
      return writer.flush(
        112
        /* code.startup */
      );
    };
    var sendSCRAMClientFinalMessage = function(additionalData) {
      return writer.addString(additionalData).flush(
        112
        /* code.startup */
      );
    };
    var query = (text9) => {
      return writer.addCString(text9).flush(
        81
        /* code.query */
      );
    };
    var emptyArray = [];
    var parse = (query2) => {
      const name = query2.name || "";
      if (name.length > 63) {
        console.error("Warning! Postgres only supports 63 characters for query names.");
        console.error("You supplied %s (%s)", name, name.length);
        console.error("This can cause conflicts and silent errors executing queries");
      }
      const types2 = query2.types || emptyArray;
      const len = types2.length;
      const buffer = writer.addCString(name).addCString(query2.text).addInt16(len);
      for (let i = 0; i < len; i++) {
        buffer.addInt32(types2[i]);
      }
      return writer.flush(
        80
        /* code.parse */
      );
    };
    var writeValues = function(values, valueMapper, formatsOffset) {
      const len = values.length;
      for (let i = 0; i < len; i++) {
        const mappedVal = valueMapper ? valueMapper(values[i], i) : values[i];
        let formatByte = 0;
        if (mappedVal == null) {
          writer.addInt32(-1);
        } else if (mappedVal instanceof Buffer) {
          formatByte = 1;
          writer.addInt32(mappedVal.length);
          writer.add(mappedVal);
        } else {
          writer.addInt32PrefixedString(mappedVal);
        }
        const buf = writer.buffer;
        buf[formatsOffset++] = 0;
        buf[formatsOffset++] = formatByte;
      }
    };
    var bind = (config = {}) => {
      const portal = config.portal || "";
      const statement = config.statement || "";
      const binary = config.binary || false;
      const values = config.values || emptyArray;
      const len = values.length;
      writer.addCString(portal).addCString(statement);
      writer.addInt16(len);
      const formatsOffset = writer.reserveUnsafe(len * 2);
      writer.addInt16(len);
      try {
        writeValues(values, config.valueMapper, formatsOffset);
      } catch (err) {
        writer.clear();
        throw err;
      }
      writer.addInt16(1);
      writer.addInt16(
        binary ? 1 : 0
        /* ParamType.STRING */
      );
      return writer.flush(
        66
        /* code.bind */
      );
    };
    var emptyExecute = Buffer.from([69, 0, 0, 0, 9, 0, 0, 0, 0, 0]);
    var execute = (config) => {
      if (!config || !config.portal && !config.rows) {
        return emptyExecute;
      }
      const portal = config.portal || "";
      const rows = config.rows || 0;
      const portalLength = Buffer.byteLength(portal);
      const len = 4 + portalLength + 1 + 4;
      const buff = Buffer.allocUnsafe(1 + len);
      buff[0] = 69;
      buff.writeInt32BE(len, 1);
      buff.write(portal, 5, "utf-8");
      buff[portalLength + 5] = 0;
      buff.writeUInt32BE(rows, buff.length - 4);
      return buff;
    };
    var cancel = (processID, secretKey) => {
      const buffer = Buffer.allocUnsafe(16);
      buffer.writeInt32BE(16, 0);
      buffer.writeInt16BE(1234, 4);
      buffer.writeInt16BE(5678, 6);
      buffer.writeInt32BE(processID, 8);
      buffer.writeInt32BE(secretKey, 12);
      return buffer;
    };
    var cstringMessage = (code2, string2) => {
      const stringLen = Buffer.byteLength(string2);
      const len = 4 + stringLen + 1;
      const buffer = Buffer.allocUnsafe(1 + len);
      buffer[0] = code2;
      buffer.writeInt32BE(len, 1);
      buffer.write(string2, 5, "utf-8");
      buffer[len] = 0;
      return buffer;
    };
    var emptyDescribePortal = writer.addCString("P").flush(
      68
      /* code.describe */
    );
    var emptyDescribeStatement = writer.addCString("S").flush(
      68
      /* code.describe */
    );
    var describe = (msg) => {
      return msg.name ? cstringMessage(68, `${msg.type}${msg.name || ""}`) : msg.type === "P" ? emptyDescribePortal : emptyDescribeStatement;
    };
    var close = (msg) => {
      const text9 = `${msg.type}${msg.name || ""}`;
      return cstringMessage(67, text9);
    };
    var copyData = (chunk) => {
      return writer.add(chunk).flush(
        100
        /* code.copyFromChunk */
      );
    };
    var copyFail = (message) => {
      return cstringMessage(102, message);
    };
    var codeOnlyBuffer = (code2) => Buffer.from([code2, 0, 0, 0, 4]);
    var flushBuffer = codeOnlyBuffer(
      72
      /* code.flush */
    );
    var syncBuffer = codeOnlyBuffer(
      83
      /* code.sync */
    );
    var endBuffer = codeOnlyBuffer(
      88
      /* code.end */
    );
    var copyDoneBuffer = codeOnlyBuffer(
      99
      /* code.copyDone */
    );
    var serialize = {
      startup,
      password,
      requestSsl,
      sendSASLInitialResponseMessage,
      sendSCRAMClientFinalMessage,
      query,
      parse,
      bind,
      execute,
      describe,
      close,
      flush: () => flushBuffer,
      sync: () => syncBuffer,
      end: () => endBuffer,
      copyData,
      copyDone: () => copyDoneBuffer,
      copyFail,
      cancel
    };
    exports2.serialize = serialize;
  }
});

// node_modules/pg-protocol/dist/buffer-reader.js
var require_buffer_reader = __commonJS({
  "node_modules/pg-protocol/dist/buffer-reader.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.BufferReader = void 0;
    var BufferReader = class {
      constructor(offset = 0) {
        this.offset = offset;
        this.buffer = Buffer.allocUnsafe(0);
        this.encoding = "utf-8";
      }
      setBuffer(offset, buffer) {
        this.offset = offset;
        this.buffer = buffer;
      }
      int16() {
        const result2 = this.buffer.readInt16BE(this.offset);
        this.offset += 2;
        return result2;
      }
      byte() {
        const result2 = this.buffer[this.offset];
        this.offset++;
        return result2;
      }
      int32() {
        const result2 = this.buffer.readInt32BE(this.offset);
        this.offset += 4;
        return result2;
      }
      uint32() {
        const result2 = this.buffer.readUInt32BE(this.offset);
        this.offset += 4;
        return result2;
      }
      string(length) {
        const result2 = this.buffer.toString(this.encoding, this.offset, this.offset + length);
        this.offset += length;
        return result2;
      }
      cstring() {
        const start = this.offset;
        let end = start;
        while (this.buffer[end++]) {
        }
        this.offset = end;
        return this.buffer.toString(this.encoding, start, end - 1);
      }
      bytes(length) {
        const result2 = this.buffer.slice(this.offset, this.offset + length);
        this.offset += length;
        return result2;
      }
    };
    exports2.BufferReader = BufferReader;
  }
});

// node_modules/pg-protocol/dist/parser.js
var require_parser = __commonJS({
  "node_modules/pg-protocol/dist/parser.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Parser = void 0;
    var messages_1 = require_messages();
    var buffer_reader_1 = require_buffer_reader();
    var CODE_LENGTH = 1;
    var LEN_LENGTH = 4;
    var HEADER_LENGTH = CODE_LENGTH + LEN_LENGTH;
    var LATEINIT_LENGTH = -1;
    var emptyBuffer = Buffer.allocUnsafe(0);
    var Parser = class {
      constructor(opts) {
        this.buffer = emptyBuffer;
        this.bufferLength = 0;
        this.bufferOffset = 0;
        this.reader = new buffer_reader_1.BufferReader();
        if ((opts === null || opts === void 0 ? void 0 : opts.mode) === "binary") {
          throw new Error("Binary mode not supported yet");
        }
        this.mode = (opts === null || opts === void 0 ? void 0 : opts.mode) || "text";
      }
      parse(buffer, callback) {
        this.mergeBuffer(buffer);
        const bufferFullLength = this.bufferOffset + this.bufferLength;
        let offset = this.bufferOffset;
        while (offset + HEADER_LENGTH <= bufferFullLength) {
          const code2 = this.buffer[offset];
          const length = this.buffer.readUInt32BE(offset + CODE_LENGTH);
          const fullMessageLength = CODE_LENGTH + length;
          if (fullMessageLength + offset <= bufferFullLength) {
            const message = this.handlePacket(offset + HEADER_LENGTH, code2, length, this.buffer);
            callback(message);
            offset += fullMessageLength;
          } else {
            break;
          }
        }
        if (offset === bufferFullLength) {
          this.buffer = emptyBuffer;
          this.bufferLength = 0;
          this.bufferOffset = 0;
        } else {
          this.bufferLength = bufferFullLength - offset;
          this.bufferOffset = offset;
        }
      }
      mergeBuffer(buffer) {
        if (this.bufferLength > 0) {
          const newLength = this.bufferLength + buffer.byteLength;
          const newFullLength = newLength + this.bufferOffset;
          if (newFullLength > this.buffer.byteLength) {
            let newBuffer;
            if (newLength <= this.buffer.byteLength && this.bufferOffset >= this.bufferLength) {
              newBuffer = this.buffer;
            } else {
              let newBufferLength = this.buffer.byteLength * 2;
              while (newLength >= newBufferLength) {
                newBufferLength *= 2;
              }
              newBuffer = Buffer.allocUnsafe(newBufferLength);
            }
            this.buffer.copy(newBuffer, 0, this.bufferOffset, this.bufferOffset + this.bufferLength);
            this.buffer = newBuffer;
            this.bufferOffset = 0;
          }
          buffer.copy(this.buffer, this.bufferOffset + this.bufferLength);
          this.bufferLength = newLength;
        } else {
          this.buffer = buffer;
          this.bufferOffset = 0;
          this.bufferLength = buffer.byteLength;
        }
      }
      handlePacket(offset, code2, length, bytes) {
        const { reader } = this;
        reader.setBuffer(offset, bytes);
        let message;
        switch (code2) {
          case 50:
            message = messages_1.bindComplete;
            break;
          case 49:
            message = messages_1.parseComplete;
            break;
          case 51:
            message = messages_1.closeComplete;
            break;
          case 110:
            message = messages_1.noData;
            break;
          case 115:
            message = messages_1.portalSuspended;
            break;
          case 99:
            message = messages_1.copyDone;
            break;
          case 87:
            message = messages_1.replicationStart;
            break;
          case 73:
            message = messages_1.emptyQuery;
            break;
          case 68:
            message = parseDataRowMessage(reader);
            break;
          case 67:
            message = parseCommandCompleteMessage(reader);
            break;
          case 90:
            message = parseReadyForQueryMessage(reader);
            break;
          case 65:
            message = parseNotificationMessage(reader);
            break;
          case 82:
            message = parseAuthenticationResponse(reader, length);
            break;
          case 83:
            message = parseParameterStatusMessage(reader);
            break;
          case 75:
            message = parseBackendKeyData(reader);
            break;
          case 69:
            message = parseErrorMessage(reader, "error");
            break;
          case 78:
            message = parseErrorMessage(reader, "notice");
            break;
          case 84:
            message = parseRowDescriptionMessage(reader);
            break;
          case 116:
            message = parseParameterDescriptionMessage(reader);
            break;
          case 71:
            message = parseCopyInMessage(reader);
            break;
          case 72:
            message = parseCopyOutMessage(reader);
            break;
          case 100:
            message = parseCopyData(reader, length);
            break;
          default:
            return new messages_1.DatabaseError("received invalid response: " + code2.toString(16), length, "error");
        }
        reader.setBuffer(0, emptyBuffer);
        message.length = length;
        return message;
      }
    };
    exports2.Parser = Parser;
    var parseReadyForQueryMessage = (reader) => {
      const status = reader.string(1);
      return new messages_1.ReadyForQueryMessage(LATEINIT_LENGTH, status);
    };
    var parseCommandCompleteMessage = (reader) => {
      const text9 = reader.cstring();
      return new messages_1.CommandCompleteMessage(LATEINIT_LENGTH, text9);
    };
    var parseCopyData = (reader, length) => {
      const chunk = reader.bytes(length - 4);
      return new messages_1.CopyDataMessage(LATEINIT_LENGTH, chunk);
    };
    var parseCopyInMessage = (reader) => parseCopyMessage(reader, "copyInResponse");
    var parseCopyOutMessage = (reader) => parseCopyMessage(reader, "copyOutResponse");
    var parseCopyMessage = (reader, messageName) => {
      const isBinary = reader.byte() !== 0;
      const columnCount = reader.int16();
      const message = new messages_1.CopyResponse(LATEINIT_LENGTH, messageName, isBinary, columnCount);
      for (let i = 0; i < columnCount; i++) {
        message.columnTypes[i] = reader.int16();
      }
      return message;
    };
    var parseNotificationMessage = (reader) => {
      const processId = reader.int32();
      const channel = reader.cstring();
      const payload = reader.cstring();
      return new messages_1.NotificationResponseMessage(LATEINIT_LENGTH, processId, channel, payload);
    };
    var parseRowDescriptionMessage = (reader) => {
      const fieldCount = reader.int16();
      const message = new messages_1.RowDescriptionMessage(LATEINIT_LENGTH, fieldCount);
      for (let i = 0; i < fieldCount; i++) {
        message.fields[i] = parseField(reader);
      }
      return message;
    };
    var parseField = (reader) => {
      const name = reader.cstring();
      const tableID = reader.uint32();
      const columnID = reader.int16();
      const dataTypeID = reader.uint32();
      const dataTypeSize = reader.int16();
      const dataTypeModifier = reader.int32();
      const mode = reader.int16() === 0 ? "text" : "binary";
      return new messages_1.Field(name, tableID, columnID, dataTypeID, dataTypeSize, dataTypeModifier, mode);
    };
    var parseParameterDescriptionMessage = (reader) => {
      const parameterCount = reader.int16();
      const message = new messages_1.ParameterDescriptionMessage(LATEINIT_LENGTH, parameterCount);
      for (let i = 0; i < parameterCount; i++) {
        message.dataTypeIDs[i] = reader.uint32();
      }
      return message;
    };
    var parseDataRowMessage = (reader) => {
      const fieldCount = reader.int16();
      const fields = new Array(fieldCount);
      for (let i = 0; i < fieldCount; i++) {
        const len = reader.int32();
        fields[i] = len === -1 ? null : reader.string(len);
      }
      return new messages_1.DataRowMessage(LATEINIT_LENGTH, fields);
    };
    var parseParameterStatusMessage = (reader) => {
      const name = reader.cstring();
      const value2 = reader.cstring();
      return new messages_1.ParameterStatusMessage(LATEINIT_LENGTH, name, value2);
    };
    var parseBackendKeyData = (reader) => {
      const processID = reader.int32();
      const secretKey = reader.int32();
      return new messages_1.BackendKeyDataMessage(LATEINIT_LENGTH, processID, secretKey);
    };
    var parseAuthenticationResponse = (reader, length) => {
      const code2 = reader.int32();
      const message = {
        name: "authenticationOk",
        length
      };
      switch (code2) {
        case 0:
          break;
        case 3:
          if (message.length === 8) {
            message.name = "authenticationCleartextPassword";
          }
          break;
        case 5:
          if (message.length === 12) {
            message.name = "authenticationMD5Password";
            const salt = reader.bytes(4);
            return new messages_1.AuthenticationMD5Password(LATEINIT_LENGTH, salt);
          }
          break;
        case 10:
          {
            message.name = "authenticationSASL";
            message.mechanisms = [];
            let mechanism;
            do {
              mechanism = reader.cstring();
              if (mechanism) {
                message.mechanisms.push(mechanism);
              }
            } while (mechanism);
          }
          break;
        case 11:
          message.name = "authenticationSASLContinue";
          message.data = reader.string(length - 8);
          break;
        case 12:
          message.name = "authenticationSASLFinal";
          message.data = reader.string(length - 8);
          break;
        default:
          throw new Error("Unknown authenticationOk message type " + code2);
      }
      return message;
    };
    var parseErrorMessage = (reader, name) => {
      const fields = {};
      let fieldType = reader.string(1);
      while (fieldType !== "\0") {
        fields[fieldType] = reader.cstring();
        fieldType = reader.string(1);
      }
      const messageValue = fields.M;
      const message = name === "notice" ? new messages_1.NoticeMessage(LATEINIT_LENGTH, messageValue) : new messages_1.DatabaseError(messageValue, LATEINIT_LENGTH, name);
      message.severity = fields.S;
      message.code = fields.C;
      message.detail = fields.D;
      message.hint = fields.H;
      message.position = fields.P;
      message.internalPosition = fields.p;
      message.internalQuery = fields.q;
      message.where = fields.W;
      message.schema = fields.s;
      message.table = fields.t;
      message.column = fields.c;
      message.dataType = fields.d;
      message.constraint = fields.n;
      message.file = fields.F;
      message.line = fields.L;
      message.routine = fields.R;
      return message;
    };
  }
});

// node_modules/pg-protocol/dist/index.js
var require_dist = __commonJS({
  "node_modules/pg-protocol/dist/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.DatabaseError = exports2.serialize = void 0;
    exports2.parse = parse;
    var messages_1 = require_messages();
    Object.defineProperty(exports2, "DatabaseError", { enumerable: true, get: function() {
      return messages_1.DatabaseError;
    } });
    var serializer_1 = require_serializer();
    Object.defineProperty(exports2, "serialize", { enumerable: true, get: function() {
      return serializer_1.serialize;
    } });
    var parser_1 = require_parser();
    function parse(stream, callback) {
      const parser = new parser_1.Parser();
      stream.on("data", (buffer) => parser.parse(buffer, callback));
      return new Promise((resolve3) => stream.on("end", () => resolve3()));
    }
  }
});

// node_modules/pg-cloudflare/dist/empty.js
var require_empty = __commonJS({
  "node_modules/pg-cloudflare/dist/empty.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.default = {};
  }
});

// node_modules/pg/lib/stream.js
var require_stream = __commonJS({
  "node_modules/pg/lib/stream.js"(exports2, module2) {
    var { getStream, getSecureStream } = getStreamFuncs();
    module2.exports = {
      /**
       * Get a socket stream compatible with the current runtime environment.
       * @returns {Duplex}
       */
      getStream,
      /**
       * Get a TLS secured socket, compatible with the current environment,
       * using the socket and other settings given in `options`.
       * @returns {Duplex}
       */
      getSecureStream
    };
    function getNodejsStreamFuncs() {
      function getStream2(ssl) {
        const net = require("net");
        return new net.Socket();
      }
      function getSecureStream2(options) {
        const tls = require("tls");
        return tls.connect(options);
      }
      return {
        getStream: getStream2,
        getSecureStream: getSecureStream2
      };
    }
    function getCloudflareStreamFuncs() {
      function getStream2(ssl) {
        const { CloudflareSocket } = require_empty();
        return new CloudflareSocket(ssl);
      }
      function getSecureStream2(options) {
        options.socket.startTls(options);
        return options.socket;
      }
      return {
        getStream: getStream2,
        getSecureStream: getSecureStream2
      };
    }
    function isCloudflareRuntime() {
      if (typeof navigator === "object" && navigator !== null && typeof navigator.userAgent === "string") {
        return navigator.userAgent === "Cloudflare-Workers";
      }
      if (typeof Response === "function") {
        const resp = new Response(null, { cf: { thing: true } });
        if (typeof resp.cf === "object" && resp.cf !== null && resp.cf.thing) {
          return true;
        }
      }
      return false;
    }
    function getStreamFuncs() {
      if (isCloudflareRuntime()) {
        return getCloudflareStreamFuncs();
      }
      return getNodejsStreamFuncs();
    }
  }
});

// node_modules/pg/lib/connection.js
var require_connection = __commonJS({
  "node_modules/pg/lib/connection.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events").EventEmitter;
    var { parse, serialize } = require_dist();
    var stream = require_stream();
    var { getStream } = stream;
    var flushBuffer = serialize.flush();
    var syncBuffer = serialize.sync();
    var endBuffer = serialize.end();
    var Connection2 = class extends EventEmitter {
      constructor(config) {
        super();
        config = config || {};
        this.stream = config.stream || getStream(config.ssl);
        if (typeof this.stream === "function") {
          this.stream = this.stream(config);
        }
        this._keepAlive = config.keepAlive;
        this._keepAliveInitialDelayMillis = config.keepAliveInitialDelayMillis;
        this.parsedStatements = {};
        this.submittedNamedStatements = {};
        this.ssl = config.ssl || false;
        this.sslNegotiation = config.sslNegotiation || "postgres";
        this._ending = false;
        this._emitMessage = false;
        const self = this;
        this.on("newListener", function(eventName) {
          if (eventName === "message") {
            self._emitMessage = true;
          }
        });
      }
      connect(port, host) {
        const self = this;
        this._connecting = true;
        this.stream.setNoDelay(true);
        this.stream.connect(port, host);
        this.stream.once("connect", function() {
          if (self._keepAlive) {
            self.stream.setKeepAlive(true, self._keepAliveInitialDelayMillis);
          }
          self.emit("connect");
        });
        const reportStreamError = function(error) {
          if (self._ending && (error.code === "ECONNRESET" || error.code === "EPIPE")) {
            return;
          }
          self.emit("error", error);
        };
        this.stream.on("error", reportStreamError);
        this.stream.on("close", function() {
          self.emit("end");
        });
        if (!this.ssl) {
          return this.attachListeners(this.stream);
        }
        if (this.sslNegotiation === "direct") {
          return this.stream.once("connect", function() {
            self.upgradeToSSL(host, reportStreamError);
          });
        }
        this.stream.once("data", function(buffer) {
          const responseCode = buffer.toString("utf8");
          switch (responseCode) {
            case "S":
              break;
            case "N":
              self.stream.end();
              return self.emit("error", new Error("The server does not support SSL connections"));
            default:
              self.stream.end();
              return self.emit("error", new Error("There was an error establishing an SSL connection"));
          }
          self.upgradeToSSL(host, reportStreamError);
        });
      }
      upgradeToSSL(host, reportStreamError) {
        const self = this;
        const options = {
          socket: self.stream,
          // tls.connect checks the server identity against `servername`, falling
          // back to `host` and then to 'localhost'. `servername` must stay unset
          // for IP addresses (see below), so `host` is needed to keep certificate
          // validation working when connecting to an IP address.
          host
        };
        if (self.ssl !== true) {
          Object.assign(options, self.ssl);
          if ("key" in self.ssl) {
            options.key = self.ssl.key;
          }
        }
        if (self.sslNegotiation === "direct") {
          options.ALPNProtocols = ["postgresql"];
        }
        const net = require("net");
        if (net.isIP && net.isIP(host) === 0) {
          options.servername = host;
        }
        try {
          self.stream = stream.getSecureStream(options);
        } catch (err) {
          return self.emit("error", err);
        }
        self.attachListeners(self.stream);
        self.stream.on("error", reportStreamError);
        self.emit("sslconnect");
      }
      attachListeners(stream2) {
        parse(stream2, (msg) => {
          const eventName = msg.name === "error" ? "errorMessage" : msg.name;
          if (this._emitMessage) {
            this.emit("message", msg);
          }
          this.emit(eventName, msg);
        });
      }
      requestSsl() {
        this.stream.write(serialize.requestSsl());
      }
      startup(config) {
        this.stream.write(serialize.startup(config));
      }
      cancel(processID, secretKey) {
        this._send(serialize.cancel(processID, secretKey));
      }
      password(password) {
        this._send(serialize.password(password));
      }
      sendSASLInitialResponseMessage(mechanism, initialResponse) {
        this._send(serialize.sendSASLInitialResponseMessage(mechanism, initialResponse));
      }
      sendSCRAMClientFinalMessage(additionalData) {
        this._send(serialize.sendSCRAMClientFinalMessage(additionalData));
      }
      _send(buffer) {
        if (!this.stream.writable) {
          return false;
        }
        return this.stream.write(buffer);
      }
      query(text9) {
        this._send(serialize.query(text9));
      }
      // send parse message
      parse(query) {
        this._send(serialize.parse(query));
      }
      // send bind message
      bind(config) {
        this._send(serialize.bind(config));
      }
      // send execute message
      execute(config) {
        this._send(serialize.execute(config));
      }
      flush() {
        if (this.stream.writable) {
          this.stream.write(flushBuffer);
        }
      }
      sync() {
        this._send(syncBuffer);
      }
      ref() {
        this.stream.ref();
      }
      unref() {
        this.stream.unref();
      }
      end() {
        this._ending = true;
        if (!this._connecting || !this.stream.writable) {
          this.stream.end();
          return;
        }
        return this.stream.write(endBuffer, () => {
          this.stream.end();
        });
      }
      close(msg) {
        this._send(serialize.close(msg));
      }
      describe(msg) {
        this._send(serialize.describe(msg));
      }
      sendCopyFromChunk(chunk) {
        this._send(serialize.copyData(chunk));
      }
      endCopyFrom() {
        this._send(serialize.copyDone());
      }
      sendCopyFail(msg) {
        this._send(serialize.copyFail(msg));
      }
    };
    module2.exports = Connection2;
  }
});

// node_modules/split2/index.js
var require_split2 = __commonJS({
  "node_modules/split2/index.js"(exports2, module2) {
    "use strict";
    var { Transform } = require("stream");
    var { StringDecoder } = require("string_decoder");
    var kLast = Symbol("last");
    var kDecoder = Symbol("decoder");
    function transform(chunk, enc, cb) {
      let list;
      if (this.overflow) {
        const buf = this[kDecoder].write(chunk);
        list = buf.split(this.matcher);
        if (list.length === 1)
          return cb();
        list.shift();
        this.overflow = false;
      } else {
        this[kLast] += this[kDecoder].write(chunk);
        list = this[kLast].split(this.matcher);
      }
      this[kLast] = list.pop();
      for (let i = 0; i < list.length; i++) {
        try {
          push(this, this.mapper(list[i]));
        } catch (error) {
          return cb(error);
        }
      }
      this.overflow = this[kLast].length > this.maxLength;
      if (this.overflow && !this.skipOverflow) {
        cb(new Error("maximum buffer reached"));
        return;
      }
      cb();
    }
    function flush(cb) {
      this[kLast] += this[kDecoder].end();
      if (this[kLast]) {
        try {
          push(this, this.mapper(this[kLast]));
        } catch (error) {
          return cb(error);
        }
      }
      cb();
    }
    function push(self, val) {
      if (val !== void 0) {
        self.push(val);
      }
    }
    function noop(incoming) {
      return incoming;
    }
    function split(matcher, mapper, options) {
      matcher = matcher || /\r?\n/;
      mapper = mapper || noop;
      options = options || {};
      switch (arguments.length) {
        case 1:
          if (typeof matcher === "function") {
            mapper = matcher;
            matcher = /\r?\n/;
          } else if (typeof matcher === "object" && !(matcher instanceof RegExp) && !matcher[Symbol.split]) {
            options = matcher;
            matcher = /\r?\n/;
          }
          break;
        case 2:
          if (typeof matcher === "function") {
            options = mapper;
            mapper = matcher;
            matcher = /\r?\n/;
          } else if (typeof mapper === "object") {
            options = mapper;
            mapper = noop;
          }
      }
      options = Object.assign({}, options);
      options.autoDestroy = true;
      options.transform = transform;
      options.flush = flush;
      options.readableObjectMode = true;
      const stream = new Transform(options);
      stream[kLast] = "";
      stream[kDecoder] = new StringDecoder("utf8");
      stream.matcher = matcher;
      stream.mapper = mapper;
      stream.maxLength = options.maxLength;
      stream.skipOverflow = options.skipOverflow || false;
      stream.overflow = false;
      stream._destroy = function(err, cb) {
        this._writableState.errorEmitted = false;
        cb(err);
      };
      return stream;
    }
    module2.exports = split;
  }
});

// node_modules/pgpass/lib/helper.js
var require_helper = __commonJS({
  "node_modules/pgpass/lib/helper.js"(exports2, module2) {
    "use strict";
    var path4 = require("path");
    var Stream = require("stream").Stream;
    var split = require_split2();
    var util = require("util");
    var defaultPort = 5432;
    var isWin = process.platform === "win32";
    var warnStream = process.stderr;
    var S_IRWXG = 56;
    var S_IRWXO = 7;
    var S_IFMT = 61440;
    var S_IFREG = 32768;
    function isRegFile(mode) {
      return (mode & S_IFMT) == S_IFREG;
    }
    var fieldNames = ["host", "port", "database", "user", "password"];
    var nrOfFields = fieldNames.length;
    var passKey = fieldNames[nrOfFields - 1];
    function warn() {
      var isWritable = warnStream instanceof Stream && true === warnStream.writable;
      if (isWritable) {
        var args = Array.prototype.slice.call(arguments).concat("\n");
        warnStream.write(util.format.apply(util, args));
      }
    }
    Object.defineProperty(module2.exports, "isWin", {
      get: function() {
        return isWin;
      },
      set: function(val) {
        isWin = val;
      }
    });
    module2.exports.warnTo = function(stream) {
      var old = warnStream;
      warnStream = stream;
      return old;
    };
    module2.exports.getFileName = function(rawEnv) {
      var env = rawEnv || process.env;
      var file = env.PGPASSFILE || (isWin ? path4.join(env.APPDATA || "./", "postgresql", "pgpass.conf") : path4.join(env.HOME || "./", ".pgpass"));
      return file;
    };
    module2.exports.usePgPass = function(stats, fname) {
      if (Object.prototype.hasOwnProperty.call(process.env, "PGPASSWORD")) {
        return false;
      }
      if (isWin) {
        return true;
      }
      fname = fname || "<unkn>";
      if (!isRegFile(stats.mode)) {
        warn('WARNING: password file "%s" is not a plain file', fname);
        return false;
      }
      if (stats.mode & (S_IRWXG | S_IRWXO)) {
        warn('WARNING: password file "%s" has group or world access; permissions should be u=rw (0600) or less', fname);
        return false;
      }
      return true;
    };
    var matcher = module2.exports.match = function(connInfo, entry) {
      return fieldNames.slice(0, -1).reduce(function(prev, field, idx) {
        if (idx == 1) {
          if (Number(connInfo[field] || defaultPort) === Number(entry[field])) {
            return prev && true;
          }
        }
        return prev && (entry[field] === "*" || entry[field] === connInfo[field]);
      }, true);
    };
    module2.exports.getPassword = function(connInfo, stream, cb) {
      var pass;
      var lineStream = stream.pipe(split());
      function onLine(line) {
        var entry = parseLine(line);
        if (entry && isValidEntry(entry) && matcher(connInfo, entry)) {
          pass = entry[passKey];
          lineStream.end();
        }
      }
      var onEnd = function() {
        stream.destroy();
        cb(pass);
      };
      var onErr = function(err) {
        stream.destroy();
        warn("WARNING: error on reading file: %s", err);
        cb(void 0);
      };
      stream.on("error", onErr);
      lineStream.on("data", onLine).on("end", onEnd).on("error", onErr);
    };
    var parseLine = module2.exports.parseLine = function(line) {
      if (line.length < 11 || line.match(/^\s+#/)) {
        return null;
      }
      var curChar = "";
      var prevChar = "";
      var fieldIdx = 0;
      var startIdx = 0;
      var endIdx = 0;
      var obj = {};
      var isLastField = false;
      var addToObj = function(idx, i0, i1) {
        var field = line.substring(i0, i1);
        if (!Object.hasOwnProperty.call(process.env, "PGPASS_NO_DEESCAPE")) {
          field = field.replace(/\\([:\\])/g, "$1");
        }
        obj[fieldNames[idx]] = field;
      };
      for (var i = 0; i < line.length - 1; i += 1) {
        curChar = line.charAt(i + 1);
        prevChar = line.charAt(i);
        isLastField = fieldIdx == nrOfFields - 1;
        if (isLastField) {
          addToObj(fieldIdx, startIdx);
          break;
        }
        if (i >= 0 && curChar == ":" && prevChar !== "\\") {
          addToObj(fieldIdx, startIdx, i + 1);
          startIdx = i + 2;
          fieldIdx += 1;
        }
      }
      obj = Object.keys(obj).length === nrOfFields ? obj : null;
      return obj;
    };
    var isValidEntry = module2.exports.isValidEntry = function(entry) {
      var rules = {
        // host
        0: function(x) {
          return x.length > 0;
        },
        // port
        1: function(x) {
          if (x === "*") {
            return true;
          }
          x = Number(x);
          return isFinite(x) && x > 0 && x < 9007199254740992 && Math.floor(x) === x;
        },
        // database
        2: function(x) {
          return x.length > 0;
        },
        // username
        3: function(x) {
          return x.length > 0;
        },
        // password
        4: function(x) {
          return x.length > 0;
        }
      };
      for (var idx = 0; idx < fieldNames.length; idx += 1) {
        var rule = rules[idx];
        var value2 = entry[fieldNames[idx]] || "";
        var res = rule(value2);
        if (!res) {
          return false;
        }
      }
      return true;
    };
  }
});

// node_modules/pgpass/lib/index.js
var require_lib = __commonJS({
  "node_modules/pgpass/lib/index.js"(exports2, module2) {
    "use strict";
    var path4 = require("path");
    var fs = require("fs");
    var helper = require_helper();
    module2.exports = function(connInfo, cb) {
      var file = helper.getFileName();
      fs.stat(file, function(err, stat2) {
        if (err || !helper.usePgPass(stat2, file)) {
          return cb(void 0);
        }
        var st = fs.createReadStream(file);
        helper.getPassword(connInfo, st, cb);
      });
    };
    module2.exports.warnTo = helper.warnTo;
  }
});

// node_modules/pg/lib/client.js
var require_client = __commonJS({
  "node_modules/pg/lib/client.js"(exports2, module2) {
    var EventEmitter = require("events").EventEmitter;
    var utils = require_utils();
    var nodeUtils = require("util");
    var sasl = require_sasl();
    var TypeOverrides2 = require_type_overrides();
    var ConnectionParameters = require_connection_parameters();
    var Query2 = require_query();
    var defaults2 = require_defaults();
    var Connection2 = require_connection();
    var crypto = require_utils2();
    var activeQueryDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Client.activeQuery is deprecated and will be removed in pg@9.0"
    );
    var queryQueueDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Client.queryQueue is deprecated and will be removed in pg@9.0."
    );
    var pgPassDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "pgpass support is deprecated and will be removed in pg@9.0. You can provide an async function as the password property to the Client/Pool constructor that returns a password instead. Within this function you can call the pgpass module in your own code."
    );
    var byoPromiseDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Passing a custom Promise implementation to the Client/Pool constructor is deprecated and will be removed in pg@9.0."
    );
    var queryQueueLengthDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead."
    );
    function coerceNumberOrDefault(value2, defaultValue) {
      if (typeof value2 === "number") {
        return Number.isFinite(value2) ? value2 : defaultValue;
      }
      if (typeof value2 === "string" && value2.trim() !== "") {
        const n = Number(value2);
        return Number.isFinite(n) ? n : defaultValue;
      }
      return defaultValue;
    }
    var Client2 = class extends EventEmitter {
      constructor(config) {
        super();
        this.connectionParameters = new ConnectionParameters(config);
        this.user = this.connectionParameters.user;
        this.database = this.connectionParameters.database;
        this.port = this.connectionParameters.port;
        this.host = this.connectionParameters.host;
        Object.defineProperty(this, "password", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: this.connectionParameters.password
        });
        this.replication = this.connectionParameters.replication;
        const c = config || {};
        if (c.Promise) {
          byoPromiseDeprecationNotice();
        }
        this._Promise = c.Promise || global.Promise;
        this._types = new TypeOverrides2(c.types);
        this._ending = false;
        this._ended = false;
        this._connecting = false;
        this._connected = false;
        this._connectionError = false;
        this._queryable = true;
        this._activeQuery = null;
        this._txStatus = null;
        this.enableChannelBinding = Boolean(c.enableChannelBinding);
        this.scramMaxIterations = coerceNumberOrDefault(c.scramMaxIterations, sasl.DEFAULT_MAX_SCRAM_ITERATIONS);
        this.connection = c.connection || new Connection2({
          stream: c.stream,
          ssl: this.connectionParameters.ssl,
          sslNegotiation: this.connectionParameters.sslnegotiation,
          keepAlive: c.keepAlive || false,
          keepAliveInitialDelayMillis: c.keepAliveInitialDelayMillis || 0,
          encoding: this.connectionParameters.client_encoding || "utf8"
        });
        this._queryQueue = [];
        this._sentQueryQueue = [];
        this.pipeline = Boolean(c.pipeline);
        this.binary = c.binary || defaults2.binary;
        this.processID = null;
        this.secretKey = null;
        this.ssl = this.connectionParameters.ssl || false;
        this.sslNegotiation = this.connectionParameters.sslnegotiation || "postgres";
        if (this.ssl && this.ssl.key) {
          Object.defineProperty(this.ssl, "key", {
            enumerable: false
          });
        }
        this._connectionTimeoutMillis = c.connectionTimeoutMillis || 0;
      }
      get activeQuery() {
        activeQueryDeprecationNotice();
        return this._activeQuery;
      }
      set activeQuery(val) {
        activeQueryDeprecationNotice();
        this._activeQuery = val;
      }
      _getActiveQuery() {
        return this._activeQuery;
      }
      _errorAllQueries(err) {
        const enqueueError = (query) => {
          process.nextTick(() => {
            query.handleError(err, this.connection);
          });
        };
        const activeQuery = this._getActiveQuery();
        if (activeQuery) {
          enqueueError(activeQuery);
          this._activeQuery = null;
        }
        this._sentQueryQueue.forEach(enqueueError);
        this._sentQueryQueue.length = 0;
        this._queryQueue.forEach(enqueueError);
        this._queryQueue.length = 0;
      }
      _connect(callback) {
        const self = this;
        const con = this.connection;
        this._connectionCallback = callback;
        if (this._connecting || this._connected) {
          const err = new Error("Client has already been connected. You cannot reuse a client.");
          process.nextTick(() => {
            callback(err);
          });
          return;
        }
        this._connecting = true;
        if (this._connectionTimeoutMillis > 0) {
          this.connectionTimeoutHandle = setTimeout(() => {
            con._ending = true;
            con.stream.destroy(new Error("timeout expired"));
          }, this._connectionTimeoutMillis);
          if (this.connectionTimeoutHandle.unref) {
            this.connectionTimeoutHandle.unref();
          }
        }
        if (this.host && this.host.indexOf("/") === 0) {
          con.connect(this.host + "/.s.PGSQL." + this.port);
        } else {
          con.connect(this.port, this.host);
        }
        con.on("connect", function() {
          if (self.ssl) {
            if (self.sslNegotiation !== "direct") {
              con.requestSsl();
            }
          } else {
            con.startup(self.getStartupConf());
          }
        });
        con.on("sslconnect", function() {
          con.startup(self.getStartupConf());
        });
        this._attachListeners(con);
        con.once("end", () => {
          const error = this._ending ? new Error("Connection terminated") : new Error("Connection terminated unexpectedly");
          clearTimeout(this.connectionTimeoutHandle);
          this._errorAllQueries(error);
          this._ended = true;
          if (!this._ending) {
            if (this._connecting && !this._connectionError) {
              if (this._connectionCallback) {
                this._connectionCallback(error);
              } else {
                this._handleErrorEvent(error);
              }
            } else if (!this._connectionError) {
              this._handleErrorEvent(error);
            }
          }
          process.nextTick(() => {
            this.emit("end");
          });
        });
      }
      connect(callback) {
        if (callback) {
          this._connect(callback);
          return;
        }
        return new this._Promise((resolve3, reject) => {
          this._connect((error) => {
            if (error) {
              reject(error);
            } else {
              resolve3(this);
            }
          });
        });
      }
      _attachListeners(con) {
        con.on("authenticationCleartextPassword", this._handleAuthCleartextPassword.bind(this));
        con.on("authenticationMD5Password", this._handleAuthMD5Password.bind(this));
        con.on("authenticationSASL", this._handleAuthSASL.bind(this));
        con.on("authenticationSASLContinue", this._handleAuthSASLContinue.bind(this));
        con.on("authenticationSASLFinal", this._handleAuthSASLFinal.bind(this));
        con.on("backendKeyData", this._handleBackendKeyData.bind(this));
        con.on("error", this._handleErrorEvent.bind(this));
        con.on("errorMessage", this._handleErrorMessage.bind(this));
        con.on("readyForQuery", this._handleReadyForQuery.bind(this));
        con.on("notice", this._handleNotice.bind(this));
        con.on("rowDescription", this._handleRowDescription.bind(this));
        con.on("dataRow", this._handleDataRow.bind(this));
        con.on("portalSuspended", this._handlePortalSuspended.bind(this));
        con.on("emptyQuery", this._handleEmptyQuery.bind(this));
        con.on("commandComplete", this._handleCommandComplete.bind(this));
        con.on("parseComplete", this._handleParseComplete.bind(this));
        con.on("copyInResponse", this._handleCopyInResponse.bind(this));
        con.on("copyData", this._handleCopyData.bind(this));
        con.on("notification", this._handleNotification.bind(this));
      }
      _getPassword(cb) {
        const con = this.connection;
        if (typeof this.password === "function") {
          this._Promise.resolve().then(() => this.password(this.connectionParameters)).then((pass) => {
            if (pass !== void 0) {
              if (typeof pass !== "string") {
                con.emit("error", new TypeError("Password must be a string"));
                return;
              }
              this.connectionParameters.password = this.password = pass;
            } else {
              this.connectionParameters.password = this.password = null;
            }
            cb();
          }).catch((err) => {
            con.emit("error", err);
          });
        } else if (this.password !== null) {
          cb();
        } else {
          try {
            const pgPass = require_lib();
            pgPass(this.connectionParameters, (pass) => {
              if (void 0 !== pass) {
                pgPassDeprecationNotice();
                this.connectionParameters.password = this.password = pass;
              }
              cb();
            });
          } catch (e) {
            this.emit("error", e);
          }
        }
      }
      _handleAuthCleartextPassword(msg) {
        this._getPassword(() => {
          this.connection.password(this.password);
        });
      }
      _handleAuthMD5Password(msg) {
        this._getPassword(async () => {
          try {
            const hashedPassword = await crypto.postgresMd5PasswordHash(this.user, this.password, msg.salt);
            this.connection.password(hashedPassword);
          } catch (e) {
            this.emit("error", e);
          }
        });
      }
      _handleAuthSASL(msg) {
        this._getPassword(() => {
          try {
            this.saslSession = sasl.startSession(
              msg.mechanisms,
              this.enableChannelBinding && this.connection.stream,
              this.scramMaxIterations
            );
            this.connection.sendSASLInitialResponseMessage(this.saslSession.mechanism, this.saslSession.response);
          } catch (err) {
            this.connection.emit("error", err);
          }
        });
      }
      async _handleAuthSASLContinue(msg) {
        try {
          await sasl.continueSession(
            this.saslSession,
            this.password,
            msg.data,
            this.enableChannelBinding && this.connection.stream
          );
          this.connection.sendSCRAMClientFinalMessage(this.saslSession.response);
        } catch (err) {
          this.connection.emit("error", err);
        }
      }
      _handleAuthSASLFinal(msg) {
        try {
          sasl.finalizeSession(this.saslSession, msg.data);
          this.saslSession = null;
        } catch (err) {
          this.connection.emit("error", err);
        }
      }
      _handleBackendKeyData(msg) {
        this.processID = msg.processID;
        this.secretKey = msg.secretKey;
      }
      _handleReadyForQuery(msg) {
        if (this._connecting) {
          this._connecting = false;
          this._connected = true;
          clearTimeout(this.connectionTimeoutHandle);
          if (this._connectionCallback) {
            this._connectionCallback(null, this);
            this._connectionCallback = null;
          }
          this.emit("connect");
        }
        const activeQuery = this._getActiveQuery();
        this._activeQuery = null;
        this._txStatus = msg?.status ?? null;
        this.readyForQuery = true;
        if (activeQuery) {
          activeQuery.handleReadyForQuery(this.connection);
        }
        this._pulseQueryQueue();
      }
      // if we receive an error event or error message
      // during the connection process we handle it here
      _handleErrorWhileConnecting(err) {
        if (this._connectionError) {
          return;
        }
        this._connectionError = true;
        clearTimeout(this.connectionTimeoutHandle);
        if (this._connectionCallback) {
          return this._connectionCallback(err);
        }
        this.emit("error", err);
      }
      // if we're connected and we receive an error event from the connection
      // this means the socket is dead - do a hard abort of all queries and emit
      // the socket error on the client as well
      _handleErrorEvent(err) {
        if (this._connecting) {
          return this._handleErrorWhileConnecting(err);
        }
        this._queryable = false;
        this._errorAllQueries(err);
        this.emit("error", err);
      }
      // handle error messages from the postgres backend
      _handleErrorMessage(msg) {
        if (this._connecting) {
          return this._handleErrorWhileConnecting(msg);
        }
        const activeQuery = this._getActiveQuery();
        if (!activeQuery) {
          this._handleErrorEvent(msg);
          return;
        }
        this._activeQuery = null;
        if (activeQuery.name) {
          delete this.connection.submittedNamedStatements[activeQuery.name];
        }
        activeQuery.handleError(msg, this.connection);
      }
      _handleRowDescription(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected rowDescription message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleRowDescription(msg);
      }
      _handleDataRow(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected dataRow message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleDataRow(msg);
      }
      _handlePortalSuspended(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected portalSuspended message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handlePortalSuspended(this.connection);
      }
      _handleEmptyQuery(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected emptyQuery message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleEmptyQuery(this.connection);
      }
      _handleCommandComplete(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected commandComplete message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleCommandComplete(msg, this.connection);
      }
      _handleParseComplete() {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected parseComplete message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        if (activeQuery.name) {
          this.connection.parsedStatements[activeQuery.name] = activeQuery.text;
          delete this.connection.submittedNamedStatements[activeQuery.name];
        }
      }
      _handleCopyInResponse(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected copyInResponse message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleCopyInResponse(this.connection);
      }
      _handleCopyData(msg) {
        const activeQuery = this._getActiveQuery();
        if (activeQuery == null) {
          const error = new Error("Received unexpected copyData message from backend.");
          this._handleErrorEvent(error);
          return;
        }
        activeQuery.handleCopyData(msg, this.connection);
      }
      _handleNotification(msg) {
        this.emit("notification", msg);
      }
      _handleNotice(msg) {
        this.emit("notice", msg);
      }
      getStartupConf() {
        const params = this.connectionParameters;
        const data = {
          user: params.user,
          database: params.database
        };
        const appName = params.application_name || params.fallback_application_name;
        if (appName) {
          data.application_name = appName;
        }
        if (params.replication) {
          data.replication = "" + params.replication;
        }
        if (params.statement_timeout) {
          data.statement_timeout = String(parseInt(params.statement_timeout, 10));
        }
        if (params.lock_timeout) {
          data.lock_timeout = String(parseInt(params.lock_timeout, 10));
        }
        if (params.idle_in_transaction_session_timeout) {
          data.idle_in_transaction_session_timeout = String(parseInt(params.idle_in_transaction_session_timeout, 10));
        }
        if (params.options) {
          data.options = params.options;
        }
        return data;
      }
      cancel(client, query) {
        if (client.activeQuery === query) {
          const con = this.connection;
          if (this.host && this.host.indexOf("/") === 0) {
            con.connect(this.host + "/.s.PGSQL." + this.port);
          } else {
            con.connect(this.port, this.host);
          }
          con.on("connect", function() {
            con.cancel(client.processID, client.secretKey);
          });
        } else if (client._queryQueue.indexOf(query) !== -1) {
          client._queryQueue.splice(client._queryQueue.indexOf(query), 1);
        } else if (client._sentQueryQueue.indexOf(query) !== -1) {
          query.callback = () => {
          };
        }
      }
      setTypeParser(oid, format, parseFn) {
        return this._types.setTypeParser(oid, format, parseFn);
      }
      getTypeParser(oid, format) {
        return this._types.getTypeParser(oid, format);
      }
      // escapeIdentifier and escapeLiteral moved to utility functions & exported
      // on PG
      // re-exported here for backwards compatibility
      escapeIdentifier(str) {
        return utils.escapeIdentifier(str);
      }
      escapeLiteral(str) {
        return utils.escapeLiteral(str);
      }
      _pulseQueryQueue() {
        if (this.pipeline) {
          this._pulsePipelinedQueryQueue();
          return;
        }
        if (this.readyForQuery === true) {
          this._activeQuery = this._queryQueue.shift();
          const activeQuery = this._getActiveQuery();
          if (activeQuery) {
            this.readyForQuery = false;
            this.hasExecuted = true;
            const queryError = activeQuery.submit(this.connection);
            if (queryError) {
              process.nextTick(() => {
                activeQuery.handleError(queryError, this.connection);
                this.readyForQuery = true;
                this._pulseQueryQueue();
              });
            }
          } else if (this.hasExecuted) {
            this._activeQuery = null;
            this.emit("drain");
          }
        }
      }
      _pulsePipelinedQueryQueue() {
        if (!this._connected || !this._queryable) {
          return;
        }
        while (this._queryQueue.length > 0) {
          const query = this._queryQueue.shift();
          this.hasExecuted = true;
          const queryError = query.submit(this.connection);
          if (queryError) {
            process.nextTick(() => {
              query.handleError(queryError, this.connection);
            });
            continue;
          }
          this._sentQueryQueue.push(query);
        }
        if (this.readyForQuery && !this._activeQuery && this._sentQueryQueue.length > 0) {
          this._activeQuery = this._sentQueryQueue.shift();
          this.readyForQuery = false;
        }
        if (!this._activeQuery && this._sentQueryQueue.length === 0 && this._queryQueue.length === 0 && this.hasExecuted) {
          this.emit("drain");
        }
      }
      query(config, values, callback) {
        let query;
        let result2;
        if (config == null) {
          throw new TypeError("Client was passed a null or undefined query");
        }
        if (typeof config.submit === "function") {
          result2 = query = config;
          if (!query.callback) {
            if (typeof values === "function") {
              query.callback = values;
            } else if (callback) {
              query.callback = callback;
            }
          }
        } else {
          query = new Query2(config, values, callback);
          if (!query.callback) {
            result2 = new this._Promise((resolve3, reject) => {
              query.callback = (err, res) => err ? reject(err) : resolve3(res);
            }).catch((err) => {
              Error.captureStackTrace(err);
              throw err;
            });
          } else if (typeof query.callback !== "function") {
            throw new TypeError("callback is not a function");
          }
        }
        const readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
        if (readTimeout) {
          const queryCallback = query.callback || (() => {
          });
          const readTimeoutTimer = setTimeout(() => {
            const error = new Error("Query read timeout");
            process.nextTick(() => {
              query.handleError(error, this.connection);
            });
            queryCallback(error);
            query.callback = () => {
            };
            const index = this._queryQueue.indexOf(query);
            if (index > -1) {
              this._queryQueue.splice(index, 1);
            } else if (this.pipeline) {
              this.connection.stream.destroy();
              return;
            }
            this._pulseQueryQueue();
          }, readTimeout);
          query.callback = (err, res) => {
            clearTimeout(readTimeoutTimer);
            queryCallback(err, res);
          };
        }
        if (this.binary && !query.binary) {
          query.binary = true;
        }
        if (query._result && !query._result._types) {
          query._result._types = this._types;
        }
        if (this.pipeline) {
          const portalQuery = typeof config.submit === "function" && !(query instanceof Query2) ? "Custom query classes such as pg-cursor and pg-query-stream are" : query.rows ? "The `rows` option is" : null;
          if (portalQuery) {
            process.nextTick(() => {
              query.handleError(new Error(`${portalQuery} not supported in pipeline mode`), this.connection);
            });
            return result2;
          }
        }
        if (!this._queryable) {
          process.nextTick(() => {
            query.handleError(new Error("Client has encountered a connection error and is not queryable"), this.connection);
          });
          return result2;
        }
        if (this._ending) {
          process.nextTick(() => {
            query.handleError(new Error("Client was closed and is not queryable"), this.connection);
          });
          return result2;
        }
        if (this._queryQueue.length > 0 && !this.pipeline) {
          queryQueueLengthDeprecationNotice();
        }
        this._queryQueue.push(query);
        this._pulseQueryQueue();
        return result2;
      }
      ref() {
        this.connection.ref();
      }
      unref() {
        this.connection.unref();
      }
      getTransactionStatus() {
        return this._txStatus;
      }
      end(cb) {
        this._ending = true;
        if (!this.connection._connecting || this._ended) {
          if (cb) {
            cb();
            return;
          } else {
            return this._Promise.resolve();
          }
        }
        if (!this._queryable) {
          this.connection.stream.destroy();
        } else if (this.pipeline && (this._getActiveQuery() || this._sentQueryQueue.length > 0 || this._queryQueue.length > 0)) {
          this.once("drain", () => this.connection.end());
        } else if (this._getActiveQuery()) {
          this.connection.stream.destroy();
        } else {
          this.connection.end();
        }
        if (cb) {
          this.connection.once("end", cb);
        } else {
          return new this._Promise((resolve3) => {
            this.connection.once("end", resolve3);
          });
        }
      }
      get queryQueue() {
        queryQueueDeprecationNotice();
        return this._queryQueue;
      }
    };
    Client2.Query = Query2;
    module2.exports = Client2;
  }
});

// node_modules/pg-pool/index.js
var require_pg_pool = __commonJS({
  "node_modules/pg-pool/index.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events").EventEmitter;
    var NOOP = function() {
    };
    var removeWhere = (list, predicate) => {
      const i = list.findIndex(predicate);
      return i === -1 ? void 0 : list.splice(i, 1)[0];
    };
    var IdleItem = class {
      constructor(client, idleListener, timeoutId) {
        this.client = client;
        this.idleListener = idleListener;
        this.timeoutId = timeoutId;
      }
    };
    var PendingItem = class {
      constructor(callback) {
        this.callback = callback;
      }
    };
    function throwOnDoubleRelease() {
      throw new Error("Release called on client which has already been released to the pool.");
    }
    function promisify(Promise2, callback) {
      if (callback) {
        return { callback, result: void 0 };
      }
      let rej;
      let res;
      const cb = function(err, client) {
        err ? rej(err) : res(client);
      };
      const result2 = new Promise2(function(resolve3, reject) {
        res = resolve3;
        rej = reject;
      }).catch((err) => {
        Error.captureStackTrace(err);
        throw err;
      });
      return { callback: cb, result: result2 };
    }
    function makeIdleListener(pool, client) {
      return function idleListener(err) {
        err.client = client;
        client.removeListener("error", idleListener);
        client.on("error", () => {
          pool.log("additional client error after disconnection due to error", err);
        });
        pool._remove(client);
        pool.emit("error", err, client);
      };
    }
    var Pool2 = class extends EventEmitter {
      constructor(options, Client2) {
        super();
        this.options = Object.assign({}, options);
        if (options != null && "password" in options) {
          Object.defineProperty(this.options, "password", {
            configurable: true,
            enumerable: false,
            writable: true,
            value: options.password
          });
        }
        if (options != null && options.ssl && options.ssl.key) {
          Object.defineProperty(this.options.ssl, "key", {
            enumerable: false
          });
        }
        this.options.max = this.options.max || this.options.poolSize || 10;
        this.options.min = this.options.min || 0;
        this.options.maxUses = this.options.maxUses || Infinity;
        this.options.allowExitOnIdle = this.options.allowExitOnIdle || false;
        this.options.maxLifetimeSeconds = this.options.maxLifetimeSeconds || 0;
        this.log = this.options.log || function() {
        };
        this.Client = this.options.Client || Client2 || require_lib2().Client;
        this.Promise = this.options.Promise || global.Promise;
        if (typeof this.options.idleTimeoutMillis === "undefined") {
          this.options.idleTimeoutMillis = 1e4;
        }
        this._clients = [];
        this._idle = [];
        this._expired = /* @__PURE__ */ new WeakSet();
        this._pendingQueue = [];
        this._endCallback = void 0;
        this.ending = false;
        this.ended = false;
      }
      _promiseTry(f) {
        const Promise2 = this.Promise;
        if (typeof Promise2.try === "function") {
          return Promise2.try(f);
        }
        return new Promise2((resolve3) => resolve3(f()));
      }
      _isFull() {
        return this._clients.length >= this.options.max;
      }
      _isAboveMin() {
        return this._clients.length > this.options.min;
      }
      _pulseQueue() {
        this.log("pulse queue");
        if (this.ended) {
          this.log("pulse queue ended");
          return;
        }
        if (this.ending) {
          this.log("pulse queue on ending");
          if (this._idle.length) {
            this._idle.slice().map((item) => {
              this._remove(item.client);
            });
          }
          if (!this._clients.length) {
            this.ended = true;
            this._endCallback();
          }
          return;
        }
        if (!this._pendingQueue.length) {
          this.log("no queued requests");
          return;
        }
        if (!this._idle.length && this._isFull()) {
          return;
        }
        const pendingItem = this._pendingQueue.shift();
        if (this._idle.length) {
          const idleItem = this._idle.pop();
          clearTimeout(idleItem.timeoutId);
          const client = idleItem.client;
          client.ref && client.ref();
          const idleListener = idleItem.idleListener;
          return this._acquireClient(client, pendingItem, idleListener, false);
        }
        if (!this._isFull()) {
          return this.newClient(pendingItem);
        }
        throw new Error("unexpected condition");
      }
      _remove(client, callback) {
        const removed = removeWhere(this._idle, (item) => item.client === client);
        if (removed !== void 0) {
          clearTimeout(removed.timeoutId);
        }
        this._clients = this._clients.filter((c) => c !== client);
        const context = this;
        client.end(() => {
          context.emit("remove", client);
          if (typeof callback === "function") {
            callback();
          }
        });
      }
      connect(cb) {
        if (this.ending) {
          const err = new Error("Cannot use a pool after calling end on the pool");
          return cb ? cb(err) : this.Promise.reject(err);
        }
        const response = promisify(this.Promise, cb);
        const result2 = response.result;
        if (this._isFull() || this._idle.length) {
          if (this._idle.length) {
            process.nextTick(() => this._pulseQueue());
          }
          if (!this.options.connectionTimeoutMillis) {
            this._pendingQueue.push(new PendingItem(response.callback));
            return result2;
          }
          const queueCallback = (err, res, done) => {
            clearTimeout(tid);
            response.callback(err, res, done);
          };
          const pendingItem = new PendingItem(queueCallback);
          const tid = setTimeout(() => {
            removeWhere(this._pendingQueue, (i) => i.callback === queueCallback);
            pendingItem.timedOut = true;
            response.callback(new Error("timeout exceeded when trying to connect"));
          }, this.options.connectionTimeoutMillis);
          if (tid.unref) {
            tid.unref();
          }
          this._pendingQueue.push(pendingItem);
          return result2;
        }
        this.newClient(new PendingItem(response.callback));
        return result2;
      }
      newClient(pendingItem) {
        const client = new this.Client(this.options);
        this._clients.push(client);
        const idleListener = makeIdleListener(this, client);
        this.log("checking client timeout");
        let tid;
        let timeoutHit = false;
        if (this.options.connectionTimeoutMillis) {
          tid = setTimeout(() => {
            if (client.connection) {
              this.log("ending client due to timeout");
              timeoutHit = true;
              client.connection.stream.destroy();
            } else if (!client.isConnected()) {
              this.log("ending client due to timeout");
              timeoutHit = true;
              client.end();
            }
          }, this.options.connectionTimeoutMillis);
        }
        this.log("connecting new client");
        client.connect((err) => {
          if (tid) {
            clearTimeout(tid);
          }
          client.on("error", idleListener);
          if (err) {
            this.log("client failed to connect", err);
            this._clients = this._clients.filter((c) => c !== client);
            if (timeoutHit) {
              err = new Error("Connection terminated due to connection timeout", { cause: err });
            }
            this._pulseQueue();
            if (!pendingItem.timedOut) {
              pendingItem.callback(err, void 0, NOOP);
            }
          } else {
            this.log("new client connected");
            if (this.options.onConnect) {
              this._promiseTry(() => this.options.onConnect(client)).then(
                () => {
                  this._afterConnect(client, pendingItem, idleListener);
                },
                (hookErr) => {
                  this._clients = this._clients.filter((c) => c !== client);
                  client.end(() => {
                    this._pulseQueue();
                    if (!pendingItem.timedOut) {
                      pendingItem.callback(hookErr, void 0, NOOP);
                    }
                  });
                }
              );
              return;
            }
            return this._afterConnect(client, pendingItem, idleListener);
          }
        });
      }
      _afterConnect(client, pendingItem, idleListener) {
        if (this.options.maxLifetimeSeconds !== 0) {
          const maxLifetimeTimeout = setTimeout(() => {
            this.log("ending client due to expired lifetime");
            this._expired.add(client);
            const idleIndex = this._idle.findIndex((idleItem) => idleItem.client === client);
            if (idleIndex !== -1) {
              this._acquireClient(
                client,
                new PendingItem((err, client2, clientRelease) => clientRelease()),
                idleListener,
                false
              );
            }
          }, this.options.maxLifetimeSeconds * 1e3);
          maxLifetimeTimeout.unref();
          client.once("end", () => clearTimeout(maxLifetimeTimeout));
        }
        return this._acquireClient(client, pendingItem, idleListener, true);
      }
      // acquire a client for a pending work item
      _acquireClient(client, pendingItem, idleListener, isNew) {
        if (isNew) {
          this.emit("connect", client);
        }
        this.emit("acquire", client);
        client.release = this._releaseOnce(client, idleListener);
        client.removeListener("error", idleListener);
        if (!pendingItem.timedOut) {
          if (isNew && this.options.verify) {
            this.options.verify(client, (err) => {
              if (err) {
                client.release(err);
                return pendingItem.callback(err, void 0, NOOP);
              }
              pendingItem.callback(void 0, client, client.release);
            });
          } else {
            pendingItem.callback(void 0, client, client.release);
          }
        } else {
          if (isNew && this.options.verify) {
            this.options.verify(client, client.release);
          } else {
            client.release();
          }
        }
      }
      // returns a function that wraps _release and throws if called more than once
      _releaseOnce(client, idleListener) {
        let released = false;
        return (err) => {
          if (released) {
            throwOnDoubleRelease();
          }
          released = true;
          this._release(client, idleListener, err);
        };
      }
      // release a client back to the poll, include an error
      // to remove it from the pool
      _release(client, idleListener, err) {
        client.on("error", idleListener);
        client._poolUseCount = (client._poolUseCount || 0) + 1;
        this.emit("release", err, client);
        if (err || this.ending || !client._queryable || client._ending || client._poolUseCount >= this.options.maxUses) {
          if (client._poolUseCount >= this.options.maxUses) {
            this.log("remove expended client");
          }
          return this._remove(client, this._pulseQueue.bind(this));
        }
        const isExpired = this._expired.has(client);
        if (isExpired) {
          this.log("remove expired client");
          this._expired.delete(client);
          return this._remove(client, this._pulseQueue.bind(this));
        }
        let tid;
        if (this.options.idleTimeoutMillis && this._isAboveMin()) {
          tid = setTimeout(() => {
            if (this._isAboveMin()) {
              this.log("remove idle client");
              this._remove(client, this._pulseQueue.bind(this));
            }
          }, this.options.idleTimeoutMillis);
          if (this.options.allowExitOnIdle) {
            tid.unref();
          }
        }
        if (this.options.allowExitOnIdle) {
          client.unref();
        }
        this._idle.push(new IdleItem(client, idleListener, tid));
        this._pulseQueue();
      }
      query(text9, values, cb) {
        if (typeof text9 === "function") {
          const response2 = promisify(this.Promise, text9);
          setImmediate(function() {
            return response2.callback(new Error("Passing a function as the first parameter to pool.query is not supported"));
          });
          return response2.result;
        }
        if (typeof values === "function") {
          cb = values;
          values = void 0;
        }
        const response = promisify(this.Promise, cb);
        cb = response.callback;
        this.connect((err, client) => {
          if (err) {
            return cb(err);
          }
          let clientReleased = false;
          const onError = (err2) => {
            if (clientReleased) {
              return;
            }
            clientReleased = true;
            client.release(err2);
            cb(err2);
          };
          client.once("error", onError);
          this.log("dispatching query");
          try {
            client.query(text9, values, (err2, res) => {
              this.log("query dispatched");
              client.removeListener("error", onError);
              if (clientReleased) {
                return;
              }
              clientReleased = true;
              client.release(err2);
              if (err2) {
                return cb(err2);
              }
              return cb(void 0, res);
            });
          } catch (err2) {
            client.release(err2);
            return cb(err2);
          }
        });
        return response.result;
      }
      end(cb) {
        this.log("ending");
        if (this.ending) {
          const err = new Error("Called end on pool more than once");
          return cb ? cb(err) : this.Promise.reject(err);
        }
        this.ending = true;
        const promised = promisify(this.Promise, cb);
        this._endCallback = promised.callback;
        this._pulseQueue();
        return promised.result;
      }
      get waitingCount() {
        return this._pendingQueue.length;
      }
      get idleCount() {
        return this._idle.length;
      }
      get expiredCount() {
        return this._clients.reduce((acc, client) => acc + (this._expired.has(client) ? 1 : 0), 0);
      }
      get totalCount() {
        return this._clients.length;
      }
    };
    module2.exports = Pool2;
  }
});

// node_modules/pg/lib/native/query.js
var require_query2 = __commonJS({
  "node_modules/pg/lib/native/query.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events").EventEmitter;
    var util = require("util");
    var utils = require_utils();
    var NativeQuery = module2.exports = function(config, values, callback) {
      EventEmitter.call(this);
      config = utils.normalizeQueryConfig(config, values, callback);
      this.text = config.text;
      this.values = config.values;
      this.name = config.name;
      this.queryMode = config.queryMode;
      this.callback = config.callback;
      this.state = "new";
      this._arrayMode = config.rowMode === "array";
      this._emitRowEvents = false;
      this.on(
        "newListener",
        function(event3) {
          if (event3 === "row")
            this._emitRowEvents = true;
        }.bind(this)
      );
    };
    util.inherits(NativeQuery, EventEmitter);
    var errorFieldMap = {
      sqlState: "code",
      statementPosition: "position",
      messagePrimary: "message",
      messageDetail: "detail",
      messageHint: "hint",
      context: "where",
      schemaName: "schema",
      tableName: "table",
      columnName: "column",
      dataTypeName: "dataType",
      constraintName: "constraint",
      sourceFile: "file",
      sourceLine: "line",
      sourceFunction: "routine"
    };
    NativeQuery.prototype.handleError = function(err) {
      const fields = this.native && this.native.pq.resultErrorFields();
      if (fields) {
        for (const key in fields) {
          const normalizedFieldName = errorFieldMap[key] || key;
          err[normalizedFieldName] = fields[key];
        }
      }
      if (this.callback) {
        this.callback(err);
      } else {
        this.emit("error", err);
      }
      this.state = "error";
    };
    NativeQuery.prototype.then = function(onSuccess, onFailure) {
      return this._getPromise().then(onSuccess, onFailure);
    };
    NativeQuery.prototype.catch = function(callback) {
      return this._getPromise().catch(callback);
    };
    NativeQuery.prototype._getPromise = function() {
      if (this._promise)
        return this._promise;
      this._promise = new Promise(
        function(resolve3, reject) {
          this._once("end", resolve3);
          this._once("error", reject);
        }.bind(this)
      );
      return this._promise;
    };
    NativeQuery.prototype.submit = function(client) {
      this.state = "running";
      const self = this;
      this.native = client.native;
      client.native.arrayMode = this._arrayMode;
      let after = function(err, rows, results) {
        client.native.arrayMode = false;
        setImmediate(function() {
          self.emit("_done");
        });
        if (err) {
          return self.handleError(err);
        }
        if (self._emitRowEvents) {
          if (results.length > 1) {
            rows.forEach((rowOfRows, i) => {
              rowOfRows.forEach((row2) => {
                self.emit("row", row2, results[i]);
              });
            });
          } else {
            rows.forEach(function(row2) {
              self.emit("row", row2, results);
            });
          }
        }
        self.state = "end";
        self.emit("end", results);
        if (self.callback) {
          self.callback(null, results);
        }
      };
      if (process.domain) {
        after = process.domain.bind(after);
      }
      if (this.name) {
        if (this.name.length > 63) {
          console.error("Warning! Postgres only supports 63 characters for query names.");
          console.error("You supplied %s (%s)", this.name, this.name.length);
          console.error("This can cause conflicts and silent errors executing queries");
        }
        const values = (this.values || []).map(utils.prepareValue);
        if (client.namedQueries[this.name] !== void 0) {
          if (this.text && client.namedQueries[this.name] !== this.text) {
            const err = new Error(`Prepared statements must be unique - '${this.name}' was used for a different statement`);
            return after(err);
          }
          return client.native.execute(this.name, values, after);
        }
        return client.native.prepare(this.name, this.text, values.length, function(err) {
          if (err)
            return after(err);
          client.namedQueries[self.name] = self.text;
          return self.native.execute(self.name, values, after);
        });
      } else if (this.values) {
        if (!Array.isArray(this.values)) {
          const err = new Error("Query values must be an array");
          return after(err);
        }
        const vals = this.values.map(utils.prepareValue);
        client.native.query(this.text, vals, after);
      } else if (this.queryMode === "extended") {
        client.native.query(this.text, [], after);
      } else {
        client.native.query(this.text, after);
      }
    };
  }
});

// node_modules/pg/lib/native/client.js
var require_client2 = __commonJS({
  "node_modules/pg/lib/native/client.js"(exports2, module2) {
    var nodeUtils = require("util");
    var Native;
    try {
      Native = require("pg-native");
    } catch (e) {
      throw e;
    }
    var TypeOverrides2 = require_type_overrides();
    var EventEmitter = require("events").EventEmitter;
    var util = require("util");
    var ConnectionParameters = require_connection_parameters();
    var NativeQuery = require_query2();
    var queryQueueLengthDeprecationNotice = nodeUtils.deprecate(
      () => {
      },
      "Calling client.query() when the client is already executing a query is deprecated and will be removed in pg@9.0. Use async/await or an external async flow control mechanism instead."
    );
    var Client2 = module2.exports = function(config) {
      EventEmitter.call(this);
      config = config || {};
      this._Promise = config.Promise || global.Promise;
      this._types = new TypeOverrides2(config.types);
      this.native = new Native({
        types: this._types
      });
      this._queryQueue = [];
      this._ending = false;
      this._connecting = false;
      this._connected = false;
      this._queryable = true;
      this.pipeline = Boolean(config.pipeline);
      this._pipelineInFlight = false;
      const cp = this.connectionParameters = new ConnectionParameters(config);
      if (config.nativeConnectionString)
        cp.nativeConnectionString = config.nativeConnectionString;
      this.user = cp.user;
      Object.defineProperty(this, "password", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: cp.password
      });
      this.database = cp.database;
      this.host = cp.host;
      this.port = cp.port;
      this.namedQueries = {};
    };
    Client2.Query = NativeQuery;
    util.inherits(Client2, EventEmitter);
    Client2.prototype._errorAllQueries = function(err) {
      const enqueueError = (query) => {
        process.nextTick(() => {
          query.native = this.native;
          query.handleError(err);
        });
      };
      if (this._hasActiveQuery()) {
        enqueueError(this._activeQuery);
        this._activeQuery = null;
      }
      this._queryQueue.forEach(enqueueError);
      this._queryQueue.length = 0;
    };
    Client2.prototype._connect = function(cb) {
      const self = this;
      if (this._connecting) {
        process.nextTick(() => cb(new Error("Client has already been connected. You cannot reuse a client.")));
        return;
      }
      this._connecting = true;
      this.connectionParameters.getLibpqConnectionString(function(err, conString) {
        if (self.connectionParameters.nativeConnectionString)
          conString = self.connectionParameters.nativeConnectionString;
        if (err)
          return cb(err);
        self.native.connect(conString, function(err2) {
          if (err2) {
            self.native.end();
            return cb(err2);
          }
          self._connected = true;
          self.native.on("error", function(err3) {
            self._queryable = false;
            self._errorAllQueries(err3);
            self.emit("error", err3);
          });
          self.native.on("notification", function(msg) {
            self.emit("notification", {
              channel: msg.relname,
              payload: msg.extra
            });
          });
          self.emit("connect");
          self._pulseQueryQueue(true);
          cb(null, this);
        });
      });
    };
    Client2.prototype.connect = function(callback) {
      if (callback) {
        this._connect(callback);
        return;
      }
      return new this._Promise((resolve3, reject) => {
        this._connect((error) => {
          if (error) {
            reject(error);
          } else {
            resolve3(this);
          }
        });
      });
    };
    Client2.prototype.query = function(config, values, callback) {
      let query;
      let result2;
      let readTimeout;
      let readTimeoutTimer;
      let queryCallback;
      if (config === null || config === void 0) {
        throw new TypeError("Client was passed a null or undefined query");
      } else if (typeof config.submit === "function") {
        readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
        result2 = query = config;
        if (typeof values === "function") {
          config.callback = values;
        }
      } else {
        readTimeout = config.query_timeout || this.connectionParameters.query_timeout;
        query = new NativeQuery(config, values, callback);
        if (!query.callback) {
          let resolveOut, rejectOut;
          result2 = new this._Promise((resolve3, reject) => {
            resolveOut = resolve3;
            rejectOut = reject;
          }).catch((err) => {
            Error.captureStackTrace(err);
            throw err;
          });
          query.callback = (err, res) => err ? rejectOut(err) : resolveOut(res);
        }
      }
      if (readTimeout) {
        queryCallback = query.callback || (() => {
        });
        readTimeoutTimer = setTimeout(() => {
          const error = new Error("Query read timeout");
          process.nextTick(() => {
            query.handleError(error, this.connection);
          });
          queryCallback(error);
          query.callback = () => {
          };
          const index = this._queryQueue.indexOf(query);
          if (index > -1) {
            this._queryQueue.splice(index, 1);
          }
          this._pulseQueryQueue();
        }, readTimeout);
        query.callback = (err, res) => {
          clearTimeout(readTimeoutTimer);
          queryCallback(err, res);
        };
      }
      if (!this._queryable) {
        query.native = this.native;
        process.nextTick(() => {
          query.handleError(new Error("Client has encountered a connection error and is not queryable"));
        });
        return result2;
      }
      if (this._ending) {
        query.native = this.native;
        process.nextTick(() => {
          query.handleError(new Error("Client was closed and is not queryable"));
        });
        return result2;
      }
      if (this._queryQueue.length > 0 && !this.pipeline) {
        queryQueueLengthDeprecationNotice();
      }
      this._queryQueue.push(query);
      this._pulseQueryQueue();
      return result2;
    };
    Client2.prototype.end = function(cb) {
      const self = this;
      this._ending = true;
      if (this._connecting && !this._connected) {
        this.once("connect", () => {
          this.end(() => {
          });
        });
      }
      let result2;
      if (!cb) {
        result2 = new this._Promise(function(resolve3, reject) {
          cb = (err) => err ? reject(err) : resolve3();
        });
      }
      const doEnd = function() {
        self.native.end(function() {
          self._connected = false;
          self._errorAllQueries(new Error("Connection terminated"));
          process.nextTick(() => {
            self.emit("end");
            if (cb)
              cb();
          });
        });
      };
      if (this.pipeline && (this._pipelineInFlight || this._queryQueue.length > 0)) {
        this.once("drain", doEnd);
      } else {
        doEnd();
      }
      return result2;
    };
    Client2.prototype._hasActiveQuery = function() {
      return this._activeQuery && this._activeQuery.state !== "error" && this._activeQuery.state !== "end";
    };
    Client2.prototype._pulseQueryQueue = function(initialConnection) {
      if (!this._connected) {
        return;
      }
      if (this.pipeline && !initialConnection) {
        return this._pulsePipelinedQueryQueue();
      }
      if (this._hasActiveQuery()) {
        return;
      }
      const query = this._queryQueue.shift();
      if (!query) {
        if (!initialConnection) {
          this.emit("drain");
        }
        return;
      }
      this._activeQuery = query;
      query.submit(this);
      const self = this;
      query.once("_done", function() {
        self._pulseQueryQueue();
      });
    };
    Client2.prototype._pulsePipelinedQueryQueue = function() {
      if (!this._connected || this._pipelineInFlight) {
        return;
      }
      if (this._queryQueue.length === 0) {
        if (this.hasExecuted) {
          this.emit("drain");
        }
        return;
      }
      this._pipelineInFlight = true;
      const self = this;
      const queries = [];
      const nativeQueries = [];
      const utils = require_utils();
      while (this._queryQueue.length > 0) {
        const query = this._queryQueue.shift();
        this.hasExecuted = true;
        nativeQueries.push(query);
        const values = query.values ? query.values.map(utils.prepareValue) : null;
        const pipelineEntry = { text: query.text, name: query.name, arrayMode: query._arrayMode };
        if (values) {
          pipelineEntry.values = values;
        }
        if (query.name && this.namedQueries[query.name]) {
          pipelineEntry._alreadyPrepared = true;
        }
        queries.push(pipelineEntry);
      }
      this.native.pipeline(queries, function(err, results) {
        self._pipelineInFlight = false;
        if (err) {
          self._connected = false;
          self._queryable = false;
          for (let i = 0; i < nativeQueries.length; i++) {
            const q = nativeQueries[i];
            q.native = self.native;
            q.handleError(err);
          }
          self._errorAllQueries(err);
          self.emit("error", err);
          self.emit("end");
          return;
        }
        for (let i = 0; i < nativeQueries.length; i++) {
          const q = nativeQueries[i];
          const r = results[i];
          q.native = self.native;
          if (r.err) {
            q.handleError(r.err);
          } else {
            if (q.name) {
              self.namedQueries[q.name] = q.text;
            }
            q.state = "end";
            q.emit("end", r.result);
            if (q.callback) {
              q.callback(null, r.result);
            }
          }
          setImmediate(function() {
            q.emit("_done");
          });
        }
        self._pulsePipelinedQueryQueue();
      });
    };
    Client2.prototype.cancel = function(query) {
      if (this._activeQuery === query) {
        this.native.cancel(function() {
        });
      } else if (this._queryQueue.indexOf(query) !== -1) {
        this._queryQueue.splice(this._queryQueue.indexOf(query), 1);
      }
    };
    Client2.prototype.ref = function() {
    };
    Client2.prototype.unref = function() {
    };
    Client2.prototype.setTypeParser = function(oid, format, parseFn) {
      return this._types.setTypeParser(oid, format, parseFn);
    };
    Client2.prototype.getTypeParser = function(oid, format) {
      return this._types.getTypeParser(oid, format);
    };
    Client2.prototype.isConnected = function() {
      return this._connected;
    };
    Client2.prototype.getTransactionStatus = function() {
      return this.native.getTransactionStatus();
    };
  }
});

// node_modules/pg/lib/native/index.js
var require_native = __commonJS({
  "node_modules/pg/lib/native/index.js"(exports2, module2) {
    "use strict";
    module2.exports = require_client2();
  }
});

// node_modules/pg/lib/index.js
var require_lib2 = __commonJS({
  "node_modules/pg/lib/index.js"(exports2, module2) {
    "use strict";
    var Client2 = require_client();
    var defaults2 = require_defaults();
    var Connection2 = require_connection();
    var Result2 = require_result();
    var utils = require_utils();
    var Pool2 = require_pg_pool();
    var TypeOverrides2 = require_type_overrides();
    var { DatabaseError: DatabaseError2 } = require_dist();
    var { escapeIdentifier: escapeIdentifier2, escapeLiteral: escapeLiteral2 } = require_utils();
    var poolFactory = (Client3) => {
      return class BoundPool extends Pool2 {
        constructor(options) {
          super(options, Client3);
        }
      };
    };
    var PG = function(clientConstructor2) {
      this.defaults = defaults2;
      this.Client = clientConstructor2;
      this.Query = this.Client.Query;
      this.Pool = poolFactory(this.Client);
      this._pools = [];
      this.Connection = Connection2;
      this.types = require_pg_types();
      this.DatabaseError = DatabaseError2;
      this.TypeOverrides = TypeOverrides2;
      this.escapeIdentifier = escapeIdentifier2;
      this.escapeLiteral = escapeLiteral2;
      this.Result = Result2;
      this.utils = utils;
    };
    var clientConstructor = Client2;
    var forceNative = false;
    try {
      forceNative = !!process.env.NODE_PG_FORCE_NATIVE;
    } catch {
    }
    if (forceNative) {
      clientConstructor = require_native();
    }
    module2.exports = new PG(clientConstructor);
    Object.defineProperty(module2.exports, "native", {
      configurable: true,
      enumerable: false,
      get() {
        let native = null;
        try {
          native = new PG(require_native());
        } catch (err) {
          if (err.code !== "MODULE_NOT_FOUND") {
            throw err;
          }
        }
        Object.defineProperty(module2.exports, "native", {
          value: native
        });
        return native;
      }
    });
  }
});

// server/core/crm.ts
var CRM_STAGES = ["reaching", "quoting", "trial", "cooperating", "lost", "other"];
var success = (data) => ({ ok: true, data });
var failure = (code2, message) => ({ ok: false, error: { code: code2, message } });

// server/core/contact-mail.ts
var CONTACT_MAIL_ROUTE = "/api/crm/contact-mail-events";
var CONTACT_MAIL_LIMITS = { key: 256, mailboxKey: 128, subject: 998, preview: 2e3, email: 254, recipients: 100, history: 200, bodyBytes: 65536 };
var CONTACT_MAIL_KINDS = ["received", "sent", "replied", "autoreply", "bounced", "cc"];
var MAIL_CLASSIFICATIONS = ["other", "replied", "autoreply", "bounced"];

// server/core/send-acceptance.ts
var SEND_ACCEPTANCE_ROUTES = {
  authorize: "/api/crm/send-authorizations",
  accept: "/api/crm/send-acceptances"
};
var SEND_AUTHORIZATION_LIMITS = {
  attempt_seconds: 600,
  clock_skew_seconds: 60,
  recipients: 100,
  sendKey: 256,
  // An actual acceptance may carry one earlier immutable IMAP observation.
  bodyBytes: CONTACT_MAIL_LIMITS.bodyBytes + CONTACT_MAIL_LIMITS.bodyBytes
};

// server/core/lead-import-fields.ts
var normalizeImportHeader = (value2) => value2.trim().toLowerCase().replace(/[\s_-]/g, "");
var IMPORT_REMARK_MAX = 2e4;
var EMPTY_IMPORT_VALUES = /* @__PURE__ */ new Set(["", "n/a", "na", "(n/a)", "null", "none", "nil", "-", "--", "\u2014", "\u6682\u65E0", "\u65E0", "\u672A\u63D0\u4F9B"]);
var DIRECT_REMARK_HEADERS = /* @__PURE__ */ new Set(["\u5907\u6CE8", "remark", "note", "notes", "\u8BF4\u660E"]);
function remarkValue(value2) {
  if (value2 === null || value2 === void 0)
    return "";
  if (typeof value2 === "string" || typeof value2 === "number" || typeof value2 === "boolean")
    return String(value2).trim();
  try {
    return JSON.stringify(value2).trim();
  } catch {
    return "";
  }
}
function unmatchedImportRemark(rawRow, mappedHeaders) {
  if (!rawRow)
    return "";
  const mapped5 = new Set(Array.from(mappedHeaders, normalizeImportHeader).filter(Boolean));
  const lines = [];
  for (const [rawHeader, rawValue] of Object.entries(rawRow)) {
    const header = rawHeader.trim();
    const normalizedHeader = normalizeImportHeader(header);
    if (!header || mapped5.has(normalizedHeader))
      continue;
    const value2 = remarkValue(rawValue);
    if (EMPTY_IMPORT_VALUES.has(value2.toLowerCase()))
      continue;
    lines.push(DIRECT_REMARK_HEADERS.has(normalizedHeader) ? value2 : `${header}\uFF1A${value2}`);
  }
  return lines.join("\n");
}

// server/core/leads.ts
var LEAD_LIMITS = { batchRows: 200, bodyBytes: 1048576, text: 500, note: IMPORT_REMARK_MAX, page: 25, pageMax: 100, key: 128, notifyMax: 20 };
var LEAD_ROUTES = { bootstrap: "/api/crm/bootstrap", imports: "/api/crm/imports", leads: "/api/crm/leads", members: "/api/crm/members", assignAction: "assign" };
var IMPORT_EMAIL_MAX = 254;
function importRowIssue(row2) {
  if (!row2.customerKey.trim())
    return "\u7F3A\u5C11\u5BA2\u6237\u7F16\u53F7";
  if (!row2.companyName.trim())
    return "\u7F3A\u5C11\u516C\u53F8\u540D\u79F0";
  if (row2.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row2.email.trim()))
    return "\u90AE\u7BB1\u683C\u5F0F\u65E0\u6548";
  if (!row2.email.trim() && ![row2.name, row2.firstName, row2.lastName, row2.phone, row2.whatsapp].some((value2) => value2?.trim()))
    return "\u81F3\u5C11\u586B\u5199\u8054\u7CFB\u4EBA\u59D3\u540D\u3001\u7535\u8BDD\u3001WhatsApp\u6216\u90AE\u7BB1\u4E4B\u4E00";
  if (row2.customerKey.length > LEAD_LIMITS.key)
    return "\u5BA2\u6237\u7F16\u53F7\u8FC7\u957F";
  if (row2.email.length > IMPORT_EMAIL_MAX)
    return "\u90AE\u7BB1\u8FC7\u957F";
  if (row2.customerType?.trim() && !["\u4EE3\u7406", "\u76F4\u5BA2"].includes(row2.customerType.trim()))
    return "\u5BA2\u6237\u7C7B\u578B\u53EA\u80FD\u586B\u5199\u4EE3\u7406\u6216\u76F4\u5BA2";
  if ([row2.companyName, row2.name, row2.country, row2.customerType, row2.businessType, row2.website, row2.firstName, row2.lastName, row2.title, row2.phone, row2.whatsapp, row2.linkedinUrl, row2.language, row2.clientType, row2.sourceLevel1, row2.sourceLevel2, row2.stage, row2.status].some((value2) => value2 !== void 0 && value2.length > LEAD_LIMITS.text))
    return "\u516C\u53F8\u6216\u8054\u7CFB\u4EBA\u5B57\u6BB5\u8FC7\u957F";
  if (row2.tags !== void 0 && (!Array.isArray(row2.tags) || row2.tags.length > LEAD_LIMITS.pageMax || row2.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > LEAD_LIMITS.text)))
    return "\u8054\u7CFB\u4EBA\u6807\u7B7E\u65E0\u6548";
  if (row2.remark !== void 0 && (typeof row2.remark !== "string" || row2.remark.length > IMPORT_REMARK_MAX))
    return "\u672A\u5339\u914D\u5B57\u6BB5\u5907\u6CE8\u8FC7\u957F";
  return void 0;
}
var FOLLOWUP_METHODS = ["email", "phone", "visit", "other", "note"];
var CONTACT_TOUCH_STATUSES = ["uncontacted", "contacted", "replied", "bounced", "autoreply"];
var FOLLOWUP_TIME_LIMITS = { future_skew_seconds: 60 };

// server/services/contact-mail.ts
var UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
var EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
var MILLISECONDS_PER_SECOND = 1e3;
var TIME_LIMITS = { hours: 24, minutes: 60, seconds: 60 };
var FIELDS = ["contactId", "customerId", "eventKey", "mailboxKey", "messageKey", "kind", "direction", "occurredAt", "subject", "preview", "fromEmail", "toEmails", "ccEmails", "advanceSendStage", "correction"];
function text(value2, max, min = 0) {
  return typeof value2 === "string" && value2.length <= max && value2.trim().length >= min && !value2.includes("\0");
}
function email(value2) {
  return text(value2, CONTACT_MAIL_LIMITS.email, 1) && EMAIL.test(value2);
}
function recipients(value2) {
  return Array.isArray(value2) && value2.length <= CONTACT_MAIL_LIMITS.recipients && value2.every(email) && new Set(value2.map((item) => item.toLowerCase())).size === value2.length;
}
function occurrence(value2) {
  if (typeof value2 !== "string")
    return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value2);
  if (!parts)
    return false;
  const day = /* @__PURE__ */ new Date(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00Z`), stamp = Date.parse(value2);
  return day.getUTCFullYear() === Number(parts[1]) && day.getUTCMonth() + 1 === Number(parts[2]) && day.getUTCDate() === Number(parts[3]) && Number(parts[4]) < TIME_LIMITS.hours && Number(parts[5]) < TIME_LIMITS.minutes && Number(parts[6]) < TIME_LIMITS.seconds && (parts[8] === void 0 || Number(parts[8]) < TIME_LIMITS.hours && Number(parts[9]) < TIME_LIMITS.minutes) && Number.isFinite(stamp) && stamp <= Date.now() + FOLLOWUP_TIME_LIMITS.future_skew_seconds * MILLISECONDS_PER_SECOND;
}
function contactMailEvent(value2) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
    return failure("INVALID_INPUT", "\u90AE\u4EF6\u4E8B\u4EF6\u53C2\u6570\u65E0\u6548");
  const v = value2;
  if (Object.hasOwn(v, "advanceSendStage") && (typeof v.advanceSendStage !== "boolean" || v.kind !== "sent" || v.direction !== "outbound"))
    return failure("INVALID_INPUT", "\u53D1\u9001\u8F6E\u6B21\u4EC5\u5141\u8BB8\u5DF2\u786E\u8BA4\u7684\u53D1\u51FA\u4E8B\u4EF6\u63A8\u8FDB");
  if (Object.keys(v).some((key) => !FIELDS.includes(key)) || !Number.isSafeInteger(v.contactId) || Number(v.contactId) < 1 || typeof v.customerId !== "string" || !UUID.test(v.customerId) || !text(v.eventKey, CONTACT_MAIL_LIMITS.key, 1) || !text(v.mailboxKey, CONTACT_MAIL_LIMITS.mailboxKey, 1) || !text(v.messageKey, CONTACT_MAIL_LIMITS.key, 1) || !CONTACT_MAIL_KINDS.includes(v.kind) || !["inbound", "outbound"].includes(v.direction) || v.kind === "sent" && v.direction !== "outbound" || ["received", "replied", "autoreply", "bounced"].includes(v.kind) && v.direction !== "inbound" || !occurrence(v.occurredAt) || !text(v.subject, CONTACT_MAIL_LIMITS.subject) || !text(v.preview, CONTACT_MAIL_LIMITS.preview) || !email(v.fromEmail) || !recipients(v.toEmails) || !recipients(v.ccEmails))
    return failure("INVALID_INPUT", "\u90AE\u4EF6\u4E8B\u4EF6\u53C2\u6570\u65E0\u6548");
  if (Object.hasOwn(v, "correction")) {
    const correction = v.correction;
    if (!correction || typeof correction !== "object" || Array.isArray(correction))
      return failure("INVALID_INPUT", "\u90AE\u4EF6\u5206\u7C7B\u66F4\u6B63\u53C2\u6570\u65E0\u6548");
    const c = correction;
    if (Object.keys(c).length !== 2 || Object.keys(c).some((k) => !["previousEventKey", "classification"].includes(k)) || !MAIL_CLASSIFICATIONS.includes(c.classification) || c.previousEventKey !== null && !text(c.previousEventKey, CONTACT_MAIL_LIMITS.key, 1) || v.direction !== "inbound" || Object.hasOwn(v, "advanceSendStage") || v.kind !== (c.classification === "other" ? "received" : c.classification))
      return failure("INVALID_INPUT", "\u90AE\u4EF6\u5206\u7C7B\u66F4\u6B63\u53C2\u6570\u65E0\u6548");
  }
  const normalized2 = { ...v, occurredAt: new Date(v.occurredAt).toISOString(), fromEmail: v.fromEmail.toLowerCase(), toEmails: v.toEmails.map((item) => item.toLowerCase()), ccEmails: v.ccEmails.map((item) => item.toLowerCase()) };
  if (normalized2.advanceSendStage === false)
    delete normalized2.advanceSendStage;
  return success(normalized2);
}
function createContactMailService(repo, tokens) {
  return { record: (token, value2) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      return Promise.resolve(failure("UNAUTHORIZED", "\u4F1A\u8BDD\u65E0\u6548"));
    const parsed = contactMailEvent(value2);
    return parsed.ok ? repo.recordContactMailEvent(tokens.hash(token), parsed.data) : Promise.resolve(parsed);
  } };
}

// server/services/send-acceptance.ts
var UUID2 = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
var EMAIL2 = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
function record(value2) {
  return !!value2 && typeof value2 === "object" && !Array.isArray(value2);
}
function text2(value2, max, min = 0) {
  return typeof value2 === "string" && value2.trim().length >= min && value2.length <= max && !value2.includes("\0");
}
function email2(value2) {
  return text2(value2, CONTACT_MAIL_LIMITS.email, 1) && EMAIL2.test(value2);
}
function invalid() {
  return failure("INVALID_INPUT", "\u53D1\u9001\u6388\u6743\u6216\u56DE\u6267\u53C2\u6570\u65E0\u6548");
}
function sendAuthorization(value2) {
  if (!record(value2) || Object.keys(value2).some((key) => !["sendKey", "fromEmail", "subject", "recipients", "ccEmails"].includes(key)) || !text2(value2.sendKey, SEND_AUTHORIZATION_LIMITS.sendKey, 1) || !email2(value2.fromEmail) || !text2(value2.subject, CONTACT_MAIL_LIMITS.subject) || !Array.isArray(value2.recipients) || !value2.recipients.length || value2.recipients.length > SEND_AUTHORIZATION_LIMITS.recipients)
    return invalid();
  if (value2.ccEmails !== void 0 && (!Array.isArray(value2.ccEmails) || value2.ccEmails.length > SEND_AUTHORIZATION_LIMITS.recipients || !value2.ccEmails.every(email2)))
    return invalid();
  const ccEmails = [...new Set((value2.ccEmails ?? []).map((value3) => value3.toLowerCase()))].sort();
  const recipients2 = [];
  for (const target of value2.recipients) {
    if (!record(target) || Object.keys(target).some((key) => !["contactId", "customerId", "email"].includes(key)) || !Number.isSafeInteger(target.contactId) || Number(target.contactId) < 1 || typeof target.customerId !== "string" || !UUID2.test(target.customerId) || !email2(target.email))
      return invalid();
    recipients2.push({ contactId: Number(target.contactId), customerId: target.customerId, email: target.email.toLowerCase() });
  }
  if (new Set(recipients2.map((target) => `${target.contactId}:${target.customerId}`)).size !== recipients2.length)
    return invalid();
  return success({ sendKey: value2.sendKey, fromEmail: value2.fromEmail.toLowerCase(), subject: value2.subject, recipients: recipients2, ccEmails });
}
function sendAcceptance(value2) {
  if (!record(value2) || Object.keys(value2).some((key) => !["authorizationId", "event", "observedEvent"].includes(key)) || typeof value2.authorizationId !== "string" || !UUID2.test(value2.authorizationId))
    return invalid();
  const parsed = contactMailEvent(value2.event);
  if (!parsed.ok)
    return parsed;
  if (parsed.data.kind !== "sent" || parsed.data.direction !== "outbound" || parsed.data.correction)
    return invalid();
  if (value2.observedEvent !== void 0) {
    const observed = contactMailEvent(value2.observedEvent);
    if (!observed.ok)
      return observed;
    if (observed.data.kind !== "sent" || observed.data.direction !== "outbound" || observed.data.correction)
      return invalid();
    return success({ authorizationId: value2.authorizationId, event: parsed.data, observedEvent: observed.data });
  }
  return success({ authorizationId: value2.authorizationId, event: parsed.data });
}
function createSendAcceptanceService(repository, tokens) {
  function run2(token, value2, parse, work) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      return Promise.resolve(failure("UNAUTHORIZED", "\u4F1A\u8BDD\u65E0\u6548"));
    const parsed = parse(value2);
    return parsed.ok ? work(tokens.hash(token), parsed.data) : Promise.resolve(parsed);
  }
  return {
    authorize: (token, value2) => run2(
      token,
      value2,
      sendAuthorization,
      (hash, input) => repository.authorizeSend(hash, input)
    ),
    accept: (token, value2) => run2(
      token,
      value2,
      sendAcceptance,
      (hash, input) => repository.acceptSend(hash, input)
    )
  };
}

// server/transport/http.ts
var import_node_http = require("node:http");

// server/core/auth.ts
var API_ROUTES = {
  live: "/health/live",
  ready: "/health/ready",
  login: "/api/auth/login",
  me: "/api/auth/me",
  logout: "/api/auth/logout",
  users: "/api/admin/users",
  crmAccess: "/api/crm/access",
  navigatorAccess: "/api/navigator/access",
  accountProfile: "/api/account/profile",
  accountGrowth: "/api/account/growth",
  accountPassword: "/api/account/password"
};
var CRM_ROLES = ["admin", "operations", "sales", "auditor"];
var CRM_CAPABILITIES = {
  admin: ["crm:manage"],
  operations: ["leads:import", "leads:publish", "leads:review"],
  sales: ["leads:claim", "leads:develop"],
  auditor: ["crm:audit"]
};
var AUTH_LIMITS = { passwordMin: 6, passwordMax: 256, emailMax: 254, tokenCharacters: 43, usersPage: 100 };
var PASSWORD_PATTERN = /^[A-Za-z0-9]+$/;
var EMAIL_LOCAL_MAX = 64;
var EMAIL_LABEL_MAX = 63;
var EMAIL_LOCAL_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
var EMAIL_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
function isAccountEmail(value2) {
  if (typeof value2 !== "string" || value2.length > AUTH_LIMITS.emailMax)
    return false;
  const parts = value2.split("@");
  if (parts.length !== 2)
    return false;
  const [local, domain] = parts;
  const labels = domain.split(".");
  return local.length <= EMAIL_LOCAL_MAX && EMAIL_LOCAL_PATTERN.test(local) && !local.startsWith(".") && !local.endsWith(".") && !local.includes("..") && labels.length > 1 && labels.every((label) => label.length <= EMAIL_LABEL_MAX && EMAIL_LABEL_PATTERN.test(label));
}
function isNewAccountPassword(value2) {
  return typeof value2 === "string" && value2.length >= AUTH_LIMITS.passwordMin && value2.length <= AUTH_LIMITS.passwordMax && PASSWORD_PATTERN.test(value2);
}
var BOOTSTRAP_LOGIN_MIN = 6;
var ONLINE_DEFAULTS = {
  host: "127.0.0.1",
  port: 55844,
  test_mode: false,
  session_ttl_seconds: 3600,
  login_window_seconds: 300,
  login_max_attempts: 8,
  login_ip_max_attempts: 64,
  request_timeout_seconds: 10,
  request_body_bytes: 4096,
  password_concurrency: 2,
  rate_bucket_max: 1e3,
  navigator_url: "http://127.0.0.1:8795",
  navigator_entry_url: "http://127.0.0.1:8795"
};
var HTTP_STATUS = {
  OK: 200,
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  DATABASE_ERROR: 503,
  UNAVAILABLE: 503,
  PASSWORD_CHANGE_REQUIRED: 403
};

// server/transport/http.ts
var MILLISECONDS_PER_SECOND2 = 1e3;
function send(response, result2) {
  if (response.destroyed || response.writableEnded)
    return;
  response.writeHead(result2.ok ? HTTP_STATUS.OK : HTTP_STATUS[result2.error.code], {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Connection": "close"
  });
  response.end(JSON.stringify(result2));
}
async function body(request2, maximum) {
  if (request2.headers["content-type"]?.split(";")[0]?.trim() !== "application/json")
    return failure("INVALID_INPUT", "\u9700\u8981 JSON \u8BF7\u6C42");
  const declared = Number(request2.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(declared) || declared < 0)
    return failure("INVALID_INPUT", "\u8BF7\u6C42\u957F\u5EA6\u65E0\u6548");
  return new Promise((resolve3) => {
    const chunks = [];
    let size = 0, finished = false, exceeded = declared > maximum;
    const finish = (result2) => {
      if (!finished) {
        finished = true;
        resolve3(result2);
      }
    };
    request2.on("data", (chunk) => {
      if (finished || exceeded)
        return;
      size += chunk.length;
      if (size > maximum) {
        exceeded = true;
        chunks.length = 0;
      } else
        chunks.push(chunk);
    });
    request2.on("end", () => {
      if (finished)
        return;
      if (exceeded) {
        finish(failure("PAYLOAD_TOO_LARGE", "\u8BF7\u6C42\u4F53\u8D85\u9650"));
        return;
      }
      try {
        finish(success(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      } catch {
        finish(failure("INVALID_INPUT", "JSON \u683C\u5F0F\u65E0\u6548"));
      }
    });
    request2.on("error", () => finish(failure("INVALID_INPUT", "\u8BF7\u6C42\u4E2D\u65AD")));
    request2.on("aborted", () => finish(failure("INVALID_INPUT", "\u8BF7\u6C42\u4E2D\u65AD")));
  });
}
function createOnlineServer(service, gate, config, log, instanceId = "integration", browser, crm, desktop) {
  const dispatch = async (request2, response) => {
    const path4 = request2.url ?? "", method = request2.method;
    const localHost = `${request2.socket.localAddress}:${request2.socket.localPort}`;
    const publicHost = config.public_origin ? new URL(config.public_origin).host : "";
    if (request2.headers.host !== localHost && (!publicHost || request2.headers.host !== publicHost)) {
      send(response, failure("FORBIDDEN", "\u670D\u52A1 Host \u65E0\u6548"));
      return;
    }
    if (browser && (path4.startsWith("/admin-api/") || path4 === "/" || path4.startsWith("/?") || path4.startsWith("/assets/"))) {
      await browser(request2, response);
      return;
    }
    if (request2.headers.origin || request2.headers["sec-fetch-site"] === "cross-site") {
      send(response, failure("FORBIDDEN", "\u5F53\u524D\u4EC5\u63A5\u53D7\u672C\u673A\u975E\u6D4F\u89C8\u5668\u8DE8\u7AD9\u8BF7\u6C42"));
      return;
    }
    if (desktop && path4.startsWith("/api/auth/desktop/")) {
      await desktop(request2, response);
      return;
    }
    if (crm && path4.startsWith("/api/crm/") && path4 !== API_ROUTES.crmAccess) {
      await crm(request2, response);
      return;
    }
    const authorization = request2.headers.authorization ?? "";
    const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization)?.[1] ?? "";
    let result2;
    if (method === "GET" && path4 === API_ROUTES.live)
      result2 = success({ status: "live", instanceId, pid: process.pid });
    else if (method === "GET" && path4 === API_ROUTES.ready)
      result2 = await service.ready();
    else if (method === "POST" && path4 === API_ROUTES.login) {
      const input = await body(request2, config.request_body_bytes);
      if (!input.ok)
        result2 = input;
      else {
        const email3 = input.data && typeof input.data === "object" && "email" in input.data && typeof input.data.email === "string" ? input.data.email.trim().toLowerCase() : "invalid";
        result2 = gate.allow(email3, request2.socket.remoteAddress ?? "unknown") ? await service.login(input.data) : failure("RATE_LIMITED", "\u767B\u5F55\u5C1D\u8BD5\u8FC7\u591A\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      }
    } else if (method === "GET" && path4 === API_ROUTES.me)
      result2 = await service.me(token);
    else if (method === "GET" && path4 === API_ROUTES.accountProfile)
      result2 = await service.accountProfile(token);
    else if (method === "POST" && path4 === API_ROUTES.accountProfile) {
      const input = await body(request2, config.request_body_bytes);
      result2 = input.ok ? await service.updateAccountProfile(token, input.data) : input;
    } else if (method === "POST" && path4 === API_ROUTES.accountGrowth) {
      const input = await body(request2, config.request_body_bytes);
      result2 = input.ok ? await service.accountGrowth(token, input.data) : input;
    } else if (method === "POST" && path4 === API_ROUTES.accountPassword) {
      const input = await body(request2, config.request_body_bytes);
      result2 = input.ok ? await service.changeAccountPassword(token, input.data) : input;
    } else if (method === "POST" && path4 === API_ROUTES.logout)
      result2 = await service.logout(token);
    else if (method === "GET" && path4 === API_ROUTES.users)
      result2 = await service.users(token);
    else if (method === "GET" && path4 === API_ROUTES.crmAccess)
      result2 = await service.crmAccess(token);
    else if (method === "GET" && path4 === API_ROUTES.navigatorAccess)
      result2 = await service.navigatorAccess(token);
    else
      result2 = failure("NOT_FOUND", "\u63A5\u53E3\u4E0D\u5B58\u5728");
    send(response, result2);
  };
  const server = (0, import_node_http.createServer)((request2, response) => {
    void dispatch(request2, response).catch(() => {
      log.write("ERROR", "identity.http", "\u8BF7\u6C42\u5904\u7406\u5931\u8D25\uFF0C\u62D2\u7EDD\u54CD\u5E94\u4E1A\u52A1\u6570\u636E");
      send(response, failure("UNAVAILABLE", "\u670D\u52A1\u6682\u4E0D\u53EF\u7528"));
    });
  });
  server.requestTimeout = config.request_timeout_seconds * MILLISECONDS_PER_SECOND2;
  server.headersTimeout = config.request_timeout_seconds * MILLISECONDS_PER_SECOND2;
  server.timeout = config.request_timeout_seconds * MILLISECONDS_PER_SECOND2;
  return server;
}

// server/transport/send-acceptance-http.ts
function createSendAcceptanceHandler(service) {
  return async (request2, response) => {
    const url = new URL(request2.url ?? "/", "http://localhost");
    if (request2.method !== "POST" || !Object.values(SEND_ACCEPTANCE_ROUTES).some((route) => route === url.pathname)) {
      send(response, failure("NOT_FOUND", "\u53D1\u9001\u5F52\u6863\u63A5\u53E3\u4E0D\u5B58\u5728"));
      return;
    }
    if (url.search) {
      send(response, failure("INVALID_INPUT", "\u53D1\u9001\u5F52\u6863\u4E0D\u63A5\u53D7\u67E5\u8BE2\u53C2\u6570"));
      return;
    }
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request2.headers.authorization ?? "")?.[1] ?? "";
    if (!token) {
      send(response, failure("UNAUTHORIZED", "\u4F1A\u8BDD\u65E0\u6548"));
      return;
    }
    const parsed = await body(request2, SEND_AUTHORIZATION_LIMITS.bodyBytes);
    if (!parsed.ok) {
      send(response, parsed);
      return;
    }
    send(response, await (url.pathname === SEND_ACCEPTANCE_ROUTES.authorize ? service.authorize(token, parsed.data) : service.accept(token, parsed.data)));
  };
}

// server/core/contact-sharing.ts
var CONTACT_SHARING_ROUTES = { shares: "/api/crm/contact-shares", members: "/api/crm/contact-shares/members" };
var CONTACT_SHARING_EVENTS = { requested: "crm.contact.share.requested", accepted: "crm.contact.share.accepted", rejected: "crm.contact.share.rejected", revoked: "crm.contact.share.revoked", updated: "crm.contact.share.updated" };
var CONTACT_SHARED_FIELDS = ["firstName", "lastName", "title", "phone", "whatsapp", "linkedinUrl", "country", "language", "clientType"];

// server/services/contact-sharing.ts
var UUID3 = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
var LIMITS = { page: 50, max: 100, key: 128 };
function record2(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function uuid(v) {
  return typeof v === "string" && UUID3.test(v);
}
function positive(v) {
  return Number.isSafeInteger(v) && Number(v) > 0;
}
function keys(v, allowed) {
  return Object.keys(v).every((k) => allowed.includes(k));
}
function invalid2() {
  return failure("INVALID_INPUT", "\u5171\u4EAB\u53C2\u6570\u65E0\u6548");
}
function version(v) {
  return positive(v.expectedVersion) && typeof v.idempotencyKey === "string" && v.idempotencyKey.trim().length > 0 && v.idempotencyKey.length <= LIMITS.key;
}
function grant(v) {
  return Array.isArray(v.editableFields) && v.editableFields.every((f) => CONTACT_SHARED_FIELDS.includes(f)) && new Set(v.editableFields).size === v.editableFields.length && typeof v.canFollowup === "boolean" && typeof v.canChangeStage === "boolean";
}
function contactShareCreate(v) {
  return record2(v) && keys(v, ["contactId", "customerId", "expectedVersion", "targetUserId", "editableFields", "canFollowup", "canChangeStage", "idempotencyKey"]) && positive(v.contactId) && uuid(v.customerId) && uuid(v.targetUserId) && version(v) && grant(v) ? success(v) : invalid2();
}
function contactShareDecision(v) {
  return record2(v) && keys(v, ["shareId", "expectedVersion", "idempotencyKey"]) && uuid(v.shareId) && version(v) ? success(v) : invalid2();
}
function contactShareUpdate(v) {
  return record2(v) && keys(v, ["shareId", "expectedVersion", "idempotencyKey", "editableFields", "canFollowup", "canChangeStage"]) && uuid(v.shareId) && version(v) && grant(v) ? success(v) : invalid2();
}
function contactShareQuery(v) {
  if (!record2(v) || !keys(v, ["view", "status", "contactId", "customerId", "limit", "offset"]))
    return invalid2();
  const q = { view: v.view ?? "incoming", limit: v.limit ?? LIMITS.page, offset: v.offset ?? 0, ...v.status !== void 0 ? { status: v.status } : {}, ...v.contactId !== void 0 ? { contactId: v.contactId } : {}, ...v.customerId !== void 0 ? { customerId: v.customerId } : {} };
  if (!["incoming", "outgoing"].includes(String(q.view)) || !positive(q.limit) || Number(q.limit) > LIMITS.max || !Number.isSafeInteger(q.offset) || Number(q.offset) < 0 || v.status !== void 0 && !["pending", "accepted", "rejected", "revoked"].includes(String(v.status)) || v.contactId !== void 0 && !positive(v.contactId) || v.customerId !== void 0 && !uuid(v.customerId))
    return invalid2();
  return success(q);
}
function createContactSharingService(repo, tokens) {
  function run2(token, v, parse, work) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      return Promise.resolve(failure("UNAUTHORIZED", "\u4F1A\u8BDD\u65E0\u6548"));
    const p = parse(v);
    return p.ok ? work(tokens.hash(token), p.data) : Promise.resolve(p);
  }
  return { shares: (t, v) => run2(t, v, contactShareQuery, (h, i) => repo.shares(h, i)), createShare: (t, v) => run2(t, v, contactShareCreate, (h, i) => repo.createShare(h, i)), decideShare: (t, a, v) => run2(t, v, contactShareDecision, (h, i) => repo.decideShare(h, a, i)), updateShare: (t, v) => run2(t, v, contactShareUpdate, (h, i) => repo.updateShare(h, i)), shareMembers: (t) => run2(t, {}, () => success({}), (h) => repo.shareMembers(h)) };
}

// server/transport/contact-sharing-http.ts
function createContactSharingHandler(service) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`), token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "")?.[1] ?? "", path4 = url.pathname;
    if (req.method === "GET" && path4 === CONTACT_SHARING_ROUTES.members) {
      send(res, await service.shareMembers(token));
      return;
    }
    if (req.method === "GET" && path4 === CONTACT_SHARING_ROUTES.shares) {
      const query = {};
      for (const [k, v] of url.searchParams) {
        if (k in query) {
          send(res, failure("INVALID_INPUT", "\u67E5\u8BE2\u53C2\u6570\u91CD\u590D"));
          return;
        }
        query[k] = ["limit", "offset", "contactId"].includes(k) ? Number(v) : v;
      }
      send(res, await service.shares(token, query));
      return;
    }
    if (req.method === "POST") {
      const parsed = await body(req, LEAD_LIMITS.bodyBytes);
      if (!parsed.ok) {
        send(res, parsed);
        return;
      }
      if (path4 === CONTACT_SHARING_ROUTES.shares) {
        send(res, await service.createShare(token, parsed.data));
        return;
      }
      const match = /^\/api\/crm\/contact-shares\/([^/]+)\/(accept|reject|revoke|update)$/.exec(path4);
      if (match) {
        if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data) || "shareId" in parsed.data && parsed.data.shareId !== match[1]) {
          send(res, failure("INVALID_INPUT", "\u8DEF\u5F84\u4E0E\u7F16\u53F7\u4E0D\u4E00\u81F4"));
          return;
        }
        const input = { ...parsed.data, shareId: match[1] };
        send(res, match[2] === "update" ? await service.updateShare(token, input) : await service.decideShare(token, match[2], input));
        return;
      }
    }
    send(res, failure("NOT_FOUND", "\u5171\u4EAB\u63A5\u53E3\u4E0D\u5B58\u5728"));
  };
}

// node_modules/pg/esm/index.mjs
var import_lib = __toESM(require_lib2(), 1);
var Client = import_lib.default.Client;
var Pool = import_lib.default.Pool;
var Connection = import_lib.default.Connection;
var types = import_lib.default.types;
var Query = import_lib.default.Query;
var DatabaseError = import_lib.default.DatabaseError;
var escapeIdentifier = import_lib.default.escapeIdentifier;
var escapeLiteral = import_lib.default.escapeLiteral;
var Result = import_lib.default.Result;
var TypeOverrides = import_lib.default.TypeOverrides;
var defaults = import_lib.default.defaults;

// server/adapters/postgres/config.ts
var import_node_fs = require("node:fs");
var import_node_path = __toESM(require("node:path"));

// server/core/postgres-test-settings.json
var postgres_test_settings_default = {
  marker: "prospector-crm-isolated-v1",
  host: "127.0.0.1",
  port: 55843,
  database: "prospector_crm_test",
  connection_timeout_seconds: 5
};

// server/adapters/postgres/config.ts
var CRM_TEST_DATABASE = postgres_test_settings_default.database;
var CRM_TEST_PORT = postgres_test_settings_default.port;
var CRM_TEST_HOST = postgres_test_settings_default.host;
var CRM_RUNTIME_MARKER = postgres_test_settings_default.marker;
var MILLISECONDS_PER_SECOND3 = 1e3;
var CONNECTION_MAX = 4;
var PRODUCTION_DATABASE = "milogin_center";
var DEFAULT_PRODUCTION_USER = "milogin_app";
var LOCAL_HOST = "127.0.0.1";
var DEFAULT_PRODUCTION_PORT = 5432;
var MAX_PORT = 65535;
var PRODUCTION_SEARCH_PATH = "prospector,public";
var PRODUCTION_OPTIONS = `-c search_path=${PRODUCTION_SEARCH_PATH}`;
var CRM_CONFIG_RELATIVE_PATH = ".work/pg-crm/config.json";
function productionHost(env) {
  const host = (env.PROSPECTOR_CENTER_PG_HOST || LOCAL_HOST).trim();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host))
    throw new Error("\u6B63\u5F0F\u4E2D\u5FC3\u6570\u636E\u5E93\u4E3B\u673A\u540D\u65E0\u6548");
  return host;
}
function productionUser(env) {
  const user = (env.PROSPECTOR_CENTER_PG_USER || DEFAULT_PRODUCTION_USER).trim();
  if (!user || /[\u0000-\u001f\u007f]/.test(user))
    throw new Error("\u6B63\u5F0F\u4E2D\u5FC3\u6570\u636E\u5E93\u7528\u6237\u540D\u65E0\u6548");
  return user;
}
function productionPool(host, port, user, password) {
  return {
    host,
    port,
    database: PRODUCTION_DATABASE,
    user,
    password,
    max: CONNECTION_MAX,
    connectionTimeoutMillis: postgres_test_settings_default.connection_timeout_seconds * MILLISECONDS_PER_SECOND3,
    application_name: "prospector-center",
    options: PRODUCTION_OPTIONS,
    ssl: false
  };
}
function readTestDatabaseConfig() {
  const value2 = JSON.parse((0, import_node_fs.readFileSync)(import_node_path.default.resolve(CRM_CONFIG_RELATIVE_PATH), "utf8"));
  if (value2.marker !== CRM_RUNTIME_MARKER || value2.database !== CRM_TEST_DATABASE || value2.user !== CRM_TEST_DATABASE || value2.host !== CRM_TEST_HOST || value2.port !== CRM_TEST_PORT || typeof value2.password !== "string" || !value2.password || value2.connection_timeout_seconds !== postgres_test_settings_default.connection_timeout_seconds) {
    throw new Error("\u6D4B\u8BD5 PG \u914D\u7F6E\u65E0\u6548\uFF1B\u7981\u6B62\u4F7F\u7528\u6B63\u5F0F\u6570\u636E\u5E93\u914D\u7F6E");
  }
  return {
    host: CRM_TEST_HOST,
    port: CRM_TEST_PORT,
    database: CRM_TEST_DATABASE,
    user: CRM_TEST_DATABASE,
    password: value2.password,
    max: CONNECTION_MAX,
    connectionTimeoutMillis: value2.connection_timeout_seconds * MILLISECONDS_PER_SECOND3,
    application_name: "prospector-crm-isolated",
    ssl: false
  };
}
function readProductionDatabaseConfig(env = process.env) {
  const dsn = env.PROSPECTOR_CENTER_PG_DSN;
  const expectedHost = productionHost(env);
  const expectedUser = productionUser(env);
  if (!dsn) {
    const password = env.PROSPECTOR_CENTER_PG_PASSWORD;
    const port2 = Number(env.PROSPECTOR_CENTER_PG_PORT || DEFAULT_PRODUCTION_PORT);
    if (!password || !Number.isSafeInteger(port2) || port2 < 1 || port2 > MAX_PORT)
      throw new Error("\u7F3A\u5C11\u6B63\u5F0F\u4E2D\u5FC3\u6570\u636E\u5E93\u8FDE\u63A5\u914D\u7F6E");
    return productionPool(expectedHost, port2, expectedUser, password);
  }
  let url;
  try {
    url = new URL(dsn);
  } catch {
    throw new Error("\u6B63\u5F0F\u4E2D\u5FC3\u6570\u636E\u5E93\u8FDE\u63A5\u914D\u7F6E\u65E0\u6548");
  }
  const port = Number(url.port || DEFAULT_PRODUCTION_PORT);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== expectedHost || !Number.isSafeInteger(port) || port < 1 || port > MAX_PORT || url.pathname !== `/${PRODUCTION_DATABASE}` || decodeURIComponent(url.username) !== expectedUser || !url.password || url.search || url.hash)
    throw new Error("\u6B63\u5F0F\u4E2D\u5FC3\u53EA\u80FD\u8FDE\u63A5\u672C\u673A\u72EC\u7ACB\u5E94\u7528\u6570\u636E\u5E93");
  return productionPool(expectedHost, port, expectedUser, decodeURIComponent(url.password));
}
function readOnlineDatabaseConfig(env = process.env) {
  if (!env.PROSPECTOR_CENTER_MODE || env.PROSPECTOR_CENTER_MODE === "test")
    return readTestDatabaseConfig();
  if (env.PROSPECTOR_CENTER_MODE === "production")
    return readProductionDatabaseConfig(env);
  throw new Error("\u672A\u77E5\u4E2D\u5FC3\u8FD0\u884C\u6A21\u5F0F");
}
function assertCenterDatabasePool(pool, env = process.env) {
  const expected = readOnlineDatabaseConfig(env);
  if (pool.options.host !== expected.host || pool.options.port !== expected.port || pool.options.database !== expected.database || pool.options.user !== expected.user) {
    throw new Error(env.PROSPECTOR_CENTER_MODE === "production" ? "\u4E2D\u5FC3\u6570\u636E\u5E93\u8FDE\u63A5\u4E0E\u8FD0\u884C\u6A21\u5F0F\u4E0D\u5339\u914D" : "\u4E2D\u5FC3\u4EC5\u5141\u8BB8\u9694\u79BB\u6D4B\u8BD5\u6570\u636E\u5E93");
  }
}

// server/adapters/postgres/repository.ts
var import_node_crypto = require("node:crypto");

// server/adapters/postgres/schema.ts
var CRM_SCHEMA_VERSION = "001-crm-foundation";
var CRM_SCHEMA_LOCK = 19041001;
var CRM_SCHEMA_SQL = `
CREATE TABLE companies (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''), domain text, industry text, country text, size text,
  backcheck_data jsonb CHECK (backcheck_data IS NULL OR jsonb_typeof(backcheck_data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_companies_name ON companies(name);
CREATE TABLE contacts (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND email <> ''),
  company_id integer REFERENCES companies(id), first_name text, last_name text, title text, phone text,
  linkedin text, country text, client_type text, language text,
  stage text NOT NULL DEFAULT 'cold', status text NOT NULL DEFAULT '',
  tags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tags) = 'array'),
  extra jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(extra) = 'object'),
  assignee text NOT NULL DEFAULT '', source text NOT NULL DEFAULT 'manual', source_detail text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_contacts_email ON contacts(lower(btrim(email)));
CREATE INDEX idx_contacts_company_id ON contacts(company_id);
CREATE INDEX idx_contacts_status ON contacts(status);
CREATE INDEX idx_contacts_updated_at ON contacts(updated_at DESC, id DESC);
CREATE TABLE interactions (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  contact_id integer NOT NULL REFERENCES contacts(id),
  type text NOT NULL CHECK (type IN ('followup','stage')),
  direction text NOT NULL DEFAULT 'internal' CHECK (direction = 'internal'),
  channel text NOT NULL DEFAULT 'crm' CHECK (channel = 'crm'),
  body_preview text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_interactions_contact_id ON interactions(contact_id, id DESC);
CREATE TABLE crm_relations (
  id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  contact_id_a integer NOT NULL REFERENCES contacts(id), contact_id_b integer NOT NULL REFERENCES contacts(id),
  relation_type text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (contact_id_a <> contact_id_b), UNIQUE (contact_id_a, contact_id_b, relation_type)
);
`;

// server/adapters/postgres/repository.ts
var COMPANY_COLUMNS = `id, name, domain, industry, country, size, backcheck_data AS "backcheckData",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
var CONTACT_COLUMNS = `id, COALESCE(email,'') AS email, company_id AS "companyId", first_name AS "firstName", last_name AS "lastName",
  title, phone, linkedin AS "linkedinUrl", country, client_type AS "clientType", language, stage, status, tags,
  extra, assignee, source, source_detail AS "sourceDetail", created_at AS "createdAt", updated_at AS "updatedAt"`;
var INTERACTION_COLUMNS = `id, contact_id AS "contactId", type, direction, channel,
  body_preview AS "bodyPreview", metadata, created_at AS "createdAt"`;
var EMAIL_CONFLICT = "23505";
var FOREIGN_KEY_ERROR = "23503";
var CHECK_ERROR = "23514";
function dates(row2) {
  return Object.fromEntries(Object.entries(row2).map(([key, value2]) => [key, value2 instanceof Date ? value2.toISOString() : value2]));
}
function sqlCode(error) {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9]+$/.test(error.code))
    return error.code;
  return "UNKNOWN";
}
function literalSearch(text9) {
  return `%${text9.replace(/[\\%_]/g, "\\$&")}%`;
}
var PostgresCrmRepository = class {
  constructor(pool, log) {
    this.pool = pool;
    this.log = log;
    assertCenterDatabasePool(pool);
    pool.on("error", (error) => {
      this.log.write("ERROR", "crm.pg.pool", `\u95F2\u7F6E\u8FDE\u63A5\u9519\u8BEF code=${sqlCode(error)}`);
    });
  }
  async execute(context, action) {
    try {
      return await action();
    } catch (error) {
      const code2 = sqlCode(error);
      this.log.write("ERROR", context, `\u6570\u636E\u5E93\u64CD\u4F5C\u5931\u8D25 code=${code2}`);
      if (code2 === EMAIL_CONFLICT)
        return failure("CONFLICT", "\u8D44\u6599\u5DF2\u5B58\u5728\uFF0C\u672A\u8986\u76D6\u73B0\u6709\u8BB0\u5F55");
      if (code2 === FOREIGN_KEY_ERROR || code2 === CHECK_ERROR)
        return failure("INVALID_INPUT", "\u8D44\u6599\u5F15\u7528\u6216\u7EA6\u675F\u65E0\u6548");
      return failure("DATABASE_ERROR", "\u6570\u636E\u5E93\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u6D4B\u8BD5\u670D\u52A1\u72B6\u6001");
    }
  }
  async transaction(action) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result2 = await action(client);
      await client.query(result2.ok ? "COMMIT" : "ROLLBACK");
      return result2;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        this.log.write("ERROR", "crm.pg.rollback", `\u56DE\u6EDA\u5931\u8D25 code=${sqlCode(rollbackError)}`);
      }
      throw error;
    } finally {
      client.release();
    }
  }
  migrate() {
    return this.execute("crm.pg.migrate", () => this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [CRM_SCHEMA_LOCK]);
      await client.query(`CREATE TABLE IF NOT EXISTS crm_schema_migrations (
        version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      const checksum = (0, import_node_crypto.createHash)("sha256").update(CRM_SCHEMA_SQL).digest("hex");
      const existing = await client.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [CRM_SCHEMA_VERSION]);
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum)
          return failure("CONFLICT", "\u5DF2\u5E94\u7528\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4\uFF0C\u62D2\u7EDD\u8986\u76D6");
      } else {
        await client.query(CRM_SCHEMA_SQL);
        await client.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES ($1,$2)", [CRM_SCHEMA_VERSION, checksum]);
        this.log.write("INFO", "crm.pg.migrate", `\u8FC1\u79FB\u5B8C\u6210 version=${CRM_SCHEMA_VERSION}`);
      }
      return success(void 0);
    }));
  }
  createCompany(input) {
    return this.execute("crm.pg.company", async () => {
      const result2 = await this.pool.query(
        `INSERT INTO companies(name,domain,industry,country,size,backcheck_data)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING ${COMPANY_COLUMNS}`,
        [
          input.name,
          input.domain ?? null,
          input.industry ?? null,
          input.country ?? null,
          input.size ?? null,
          input.backcheckData == null ? null : JSON.stringify(input.backcheckData)
        ]
      );
      return success(dates(result2.rows[0]));
    });
  }
  createContact(input) {
    return this.execute("crm.pg.contact", async () => {
      const result2 = await this.pool.query(
        `INSERT INTO contacts(email,company_id,first_name,last_name,title,phone,
        linkedin,country,client_type,language,stage,status,tags,extra,assignee,source,source_detail)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING ${CONTACT_COLUMNS}`,
        [
          input.email,
          input.companyId ?? null,
          input.firstName ?? null,
          input.lastName ?? null,
          input.title ?? null,
          input.phone ?? null,
          input.linkedinUrl ?? null,
          input.country ?? null,
          input.clientType ?? null,
          input.language ?? null,
          input.stage ?? "cold",
          input.status ?? "",
          JSON.stringify(input.tags ?? []),
          JSON.stringify(input.extra ?? {}),
          input.assignee ?? "",
          input.source ?? "manual",
          input.sourceDetail ?? null
        ]
      );
      return success(dates(result2.rows[0]));
    });
  }
  getContact(id) {
    return this.execute("crm.pg.getContact", async () => {
      const result2 = await this.pool.query(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id=$1`, [id]);
      return result2.rows.length ? success(dates(result2.rows[0])) : failure("NOT_FOUND", "\u8054\u7CFB\u4EBA\u4E0D\u5B58\u5728");
    });
  }
  listContacts(query) {
    return this.execute("crm.pg.listContacts", () => this.transaction(async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const filter = `WHERE ($1 = '' OR email ILIKE $2 ESCAPE '\\' OR first_name ILIKE $2 ESCAPE '\\'
        OR last_name ILIKE $2 ESCAPE '\\')`;
      const params = [query.search, literalSearch(query.search)];
      const count = await client.query(`SELECT count(*)::int AS total FROM contacts ${filter}`, params);
      const rows = await client.query(`SELECT ${CONTACT_COLUMNS} FROM contacts ${filter}
        ORDER BY updated_at DESC,id DESC LIMIT $3 OFFSET $4`, [...params, query.limit, query.offset]);
      return success({ items: rows.rows.map((row2) => dates(row2)), total: count.rows[0].total });
    }));
  }
  addFollowup(contactId, note) {
    return this.execute("crm.pg.followup", () => this.transaction(async (client) => {
      const contact2 = await client.query("SELECT id FROM contacts WHERE id=$1 FOR KEY SHARE", [contactId]);
      if (!contact2.rows.length)
        return failure("NOT_FOUND", "\u8054\u7CFB\u4EBA\u4E0D\u5B58\u5728");
      const result2 = await client.query(`INSERT INTO interactions(contact_id,type,body_preview)
        VALUES($1,'followup',$2) RETURNING ${INTERACTION_COLUMNS}`, [contactId, note]);
      return success(dates(result2.rows[0]));
    }));
  }
  changeStage(contactId, stage) {
    return this.execute("crm.pg.stage", () => this.transaction(async (client) => {
      const before = await client.query("SELECT tags FROM contacts WHERE id=$1 FOR UPDATE", [contactId]);
      if (!before.rows.length)
        return failure("NOT_FOUND", "\u8054\u7CFB\u4EBA\u4E0D\u5B58\u5728");
      const previous = before.rows[0].tags;
      if (previous.length === 1 && previous[0] === stage) {
        const unchanged = await client.query(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id=$1`, [contactId]);
        return success(dates(unchanged.rows[0]));
      }
      const updated = await client.query(`UPDATE contacts SET tags=$2,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING ${CONTACT_COLUMNS}`, [contactId, JSON.stringify([stage])]);
      await client.query(
        "INSERT INTO interactions(contact_id,type,metadata) VALUES($1,'stage',$2)",
        [contactId, JSON.stringify({ from: previous, to: stage })]
      );
      return success(dates(updated.rows[0]));
    }));
  }
  listInteractions(contactId) {
    return this.execute("crm.pg.timeline", async () => {
      const result2 = await this.pool.query(`SELECT ${INTERACTION_COLUMNS} FROM interactions WHERE contact_id=$1 ORDER BY id DESC`, [contactId]);
      return success(result2.rows.map((row2) => dates(row2)));
    });
  }
};

// server/adapters/postgres/auth-repository.ts
var import_node_crypto3 = require("node:crypto");

// server/adapters/postgres/auth-schema.ts
var AUTH_SCHEMA_VERSION = "002-identity-foundation-public";
var AUTH_SCHEMA_LOCK = 19041002;
var AUTH_SCHEMA_SQL = `
CREATE TABLE public.identity_users (
  user_id uuid PRIMARY KEY, display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  active boolean NOT NULL DEFAULT true, identity_admin boolean NOT NULL DEFAULT false,
  security_revision integer NOT NULL DEFAULT 1 CHECK (security_revision > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.identity_login_emails (
  user_id uuid PRIMARY KEY REFERENCES public.identity_users(user_id),
  email text NOT NULL UNIQUE CHECK (email=lower(btrim(email)) AND email<>''), verified_at timestamptz
);
CREATE TABLE public.identity_credentials (
  user_id uuid PRIMARY KEY REFERENCES public.identity_users(user_id), password_hash text NOT NULL,
  hash_scheme text NOT NULL CHECK (hash_scheme='scrypt-v1'), changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.identity_product_grants (
  user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  product_id text NOT NULL CHECK (product_id='crm'), role text NOT NULL CHECK (role IN ('admin','operations','sales')),
  active boolean NOT NULL DEFAULT true, PRIMARY KEY(user_id,product_id,role)
);
CREATE TABLE public.identity_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid NOT NULL REFERENCES public.identity_users(user_id), security_revision integer NOT NULL,
  expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX idx_identity_sessions_user ON public.identity_sessions(user_id);
CREATE INDEX idx_identity_sessions_expiry ON public.identity_sessions(expires_at);
CREATE TABLE public.identity_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid REFERENCES public.identity_users(user_id),
  event text NOT NULL CHECK (event IN ('login','logout','fixture')),
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

// server/adapters/postgres/admin-repository.ts
var import_node_crypto2 = require("node:crypto");
var import_promises = require("node:fs/promises");
var import_node_path2 = __toESM(require("node:path"));

// server/core/admin.ts
var ADMIN_ROUTES = {
  login: "/admin-api/login",
  me: "/admin-api/me",
  logout: "/admin-api/logout",
  users: "/admin-api/users",
  products: "/admin-api/products",
  sessions: "/admin-api/sessions",
  audit: "/admin-api/audit",
  mutate: "/admin-api/command",
  consume: "/admin-api/challenge",
  password: "/admin-api/password",
  dashboard: "/admin-api/dashboard",
  operations: "/admin-api/operations",
  data: "/admin-api/data",
  navigatorDashboard: "/admin-api/navigator/dashboard"
};
var ADMIN_LIMITS = { page: 25, pageMax: 100, searchMax: 254, reasonMax: 500, displayNameMax: 80, challenge_ttl_seconds: 900 };
var SCOPES = ["own", "shared", "summary"];
var ROLE_CAPABILITIES = {
  admin: ["leads.assign", "leads.create", "leads.read.all", "leads.develop", "members.read", "access.manage", "roles.manage", "audit.read", "interactions.read", "metrics.read"],
  operations: ["leads.create", "leads.develop", "members.read", "leads.import", "leads.publish", "leads.assign", "leads.reclaim", "followups.read", "interactions.read", "metrics.read"],
  sales: ["leads.create", "leads.claim", "leads.develop", "followups.read", "interactions.read"],
  auditor: ["members.read", "audit.read", "interactions.read", "metrics.read"]
};
function capabilitiesFor(roles) {
  return [...new Set(roles.flatMap((role) => [...ROLE_CAPABILITIES[role]]))].sort();
}
function navigatorGrantRoleFor(role) {
  return role === "operations" ? "operations" : "sales";
}
function productPermissionsFor(role) {
  const inherited = role === "admin" ? [...CRM_ROLES] : role === "operations" ? ["operations", "sales"] : [role];
  return { roles: [role], capabilities: capabilitiesFor(inherited), scope: role === "admin" || role === "auditor" ? "summary" : role === "operations" ? "shared" : "own" };
}
function effectiveCapabilitiesFor(roles, stored) {
  if (stored == null)
    return capabilitiesFor(roles);
  const allowed = new Set(roles.flatMap((role) => productPermissionsFor(role).capabilities));
  return stored.filter((capability) => allowed.has(capability));
}

// server/adapters/postgres/admin-schema.ts
var ADMIN_VERSION = "003-management-m1-public";
var ADMIN_LOCK = 19041003;
var ADMIN_SQL = `
ALTER TABLE public.identity_users ADD COLUMN IF NOT EXISTS management_revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.identity_sessions ADD COLUMN IF NOT EXISTS session_id uuid UNIQUE NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.identity_sessions ADD COLUMN IF NOT EXISTS client text NOT NULL DEFAULT 'api' CHECK (client IN ('api','browser'));
ALTER TABLE public.identity_product_grants DROP CONSTRAINT IF EXISTS identity_product_grants_role_check;
ALTER TABLE public.identity_product_grants ADD CONSTRAINT identity_product_grants_role_check CHECK (role IN ('admin','operations','sales','auditor'));
CREATE TABLE public.identity_products (
 product_id text PRIMARY KEY, name text NOT NULL, connected boolean NOT NULL DEFAULT false, description text NOT NULL
);
INSERT INTO public.identity_products VALUES
 ('crm','Prospector',true,'\u6D4B\u8BD5\u8EAB\u4EFD\u4E0E\u6388\u6743\u5DF2\u63A5\u5165\uFF1B\u4E1A\u52A1\u4EA4\u4E92\u5C1A\u672A\u5728\u7EBF\u63A5\u5165'),
 ('navigator','Navigator',false,'\u6210\u5458\u3001\u4EA4\u4E92\u4E0E\u7BA1\u7406\u5BA1\u8BA1\u5C1A\u672A\u63A5\u5165\uFF1B\u6B64\u5E73\u53F0\u4E0D\u63D0\u4F9B\u8FD0\u4EF7\u67E5\u8BE2')
ON CONFLICT(product_id) DO NOTHING;
CREATE TABLE public.identity_product_access (
 user_id uuid NOT NULL REFERENCES public.identity_users(user_id),product_id text NOT NULL REFERENCES public.identity_products(product_id),
 active boolean NOT NULL DEFAULT true,scope text NOT NULL CHECK(scope IN ('own','shared','summary')),
 capabilities jsonb CHECK(capabilities IS NULL OR jsonb_typeof(capabilities)='array'),PRIMARY KEY(user_id,product_id)
);
INSERT INTO public.identity_product_access(user_id,product_id,scope)
 SELECT user_id,'crm',CASE WHEN bool_or(role='admin') THEN 'summary' WHEN bool_or(role='operations') THEN 'shared' ELSE 'own' END
 FROM public.identity_product_grants GROUP BY user_id;
CREATE TABLE public.identity_management_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),
 target_id uuid REFERENCES public.identity_users(user_id),action text NOT NULL,product_id text REFERENCES public.identity_products(product_id),
 reason text NOT NULL CHECK(btrim(reason)<>''),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.identity_management_challenges (
 token_hash text PRIMARY KEY CHECK(token_hash~'^[a-f0-9]{64}$'),user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
 purpose text NOT NULL CHECK(purpose IN ('activate','recover')),issuer_id uuid NOT NULL REFERENCES public.identity_users(user_id),
 email text NOT NULL,expires_at timestamptz NOT NULL,consumed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.identity_outbox (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_type text NOT NULL,user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
 product_id text REFERENCES public.identity_products(product_id),revision integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
`;

// server/adapters/postgres/user-lifecycle-schema.ts
var USER_LIFECYCLE_VERSION = "015-user-lifecycle-public";
var USER_LIFECYCLE_SQL = `
ALTER TABLE public.identity_users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.identity_users DROP CONSTRAINT IF EXISTS deleted_user_inactive;
ALTER TABLE public.identity_users ADD CONSTRAINT deleted_user_inactive CHECK(deleted_at IS NULL OR NOT active);
`;

// server/adapters/postgres/navigator-access-schema.ts
var NAVIGATOR_ACCESS_VERSION = "005-navigator-access-public";
var NAVIGATOR_PRODUCT_VERSION = "006-navigator-product-public";
var NAVIGATOR_ACCESS_SQL = `
ALTER TABLE public.identity_product_grants DROP CONSTRAINT IF EXISTS identity_product_grants_product_id_check;
ALTER TABLE public.identity_product_grants ADD CONSTRAINT identity_product_grants_product_id_check
 CHECK (product_id IN ('crm','navigator'));
`;
var NAVIGATOR_PRODUCT_SQL = `
UPDATE public.identity_products
SET connected = true,
    description = '\u4E2D\u5FC3\u8EAB\u4EFD\u3001\u4EA7\u54C1\u51C6\u5165\u4E0E\u8FD0\u4EF7\u5E93\u8D26\u53F7\u6388\u6743\u5DF2\u63A5\u5165\uFF1B\u8FD0\u4EF7\u4E1A\u52A1\u4ECD\u7531 Navigator \u670D\u52A1\u63D0\u4F9B'
WHERE product_id = 'navigator';
`;

// server/core/management-dashboard.ts
var DASHBOARD_LIMITS = { receipts: 20, stale_event_seconds: 60 };
var OPERATIONS_LIMITS = {
  disk_attention_usage_percent: 85,
  disk_offline_usage_percent: 95
};
function canReadManagementDashboard(actor) {
  return actor.identityAdmin || actor.scope === "summary" && actor.capabilities.includes("metrics.read") && actor.roles.some((role) => role === "admin" || role === "auditor");
}

// server/core/admin-data-browser.ts
var ADMIN_DATA_BROWSER_LIMITS = {
  page: 25,
  pageMax: 100,
  pageSizes: [25, 50, 100],
  searchMax: 254,
  statement_timeout_seconds: 5
};
var ADMIN_DATA_TABLES = [
  { id: "public.identity_users", group: "\u8D26\u53F7\u4E0E\u6743\u9650", label: "\u7528\u6237", description: "\u4E2D\u5FC3\u8D26\u53F7\u3001\u542F\u7528\u72B6\u6001\u4E0E\u6743\u9650\u4FEE\u8BA2", schema: "public", table: "identity_users", keyColumn: "user_id", defaultSort: "created_at", defaultDirection: "desc" },
  { id: "public.identity_login_emails", group: "\u8D26\u53F7\u4E0E\u6743\u9650", label: "\u767B\u5F55\u90AE\u7BB1", description: "\u8D26\u53F7\u767B\u5F55\u90AE\u7BB1\u4E0E\u9A8C\u8BC1\u72B6\u6001", schema: "public", table: "identity_login_emails", keyColumn: "email", defaultSort: "email", defaultDirection: "asc" },
  { id: "public.identity_products", group: "\u8D26\u53F7\u4E0E\u6743\u9650", label: "\u4EA7\u54C1", description: "\u7EDF\u4E00\u7BA1\u7406\u4E2D\u5FC3\u4EA7\u54C1\u76EE\u5F55", schema: "public", table: "identity_products", keyColumn: "product_id", defaultSort: "product_id", defaultDirection: "asc" },
  { id: "public.identity_product_grants", group: "\u8D26\u53F7\u4E0E\u6743\u9650", label: "\u4EA7\u54C1\u89D2\u8272", description: "\u7528\u6237\u5728\u5404\u4EA7\u54C1\u4E2D\u7684\u89D2\u8272\u6388\u6743", schema: "public", table: "identity_product_grants", keyColumn: "user_id", defaultSort: "user_id", defaultDirection: "asc" },
  { id: "public.identity_product_access", group: "\u8D26\u53F7\u4E0E\u6743\u9650", label: "\u4EA7\u54C1\u51C6\u5165", description: "\u4EA7\u54C1\u542F\u7528\u72B6\u6001\u3001\u6570\u636E\u8303\u56F4\u4E0E\u80FD\u529B", schema: "public", table: "identity_product_access", keyColumn: "user_id", defaultSort: "user_id", defaultDirection: "asc" },
  { id: "public.identity_management_audit", group: "\u8D26\u53F7\u4E0E\u6743\u9650", label: "\u7BA1\u7406\u5BA1\u8BA1", description: "\u4E2D\u5FC3\u540E\u53F0\u7BA1\u7406\u52A8\u4F5C\u4E0E\u539F\u56E0", schema: "public", table: "identity_management_audit", keyColumn: "id", defaultSort: "created_at", defaultDirection: "desc" },
  { id: "prospector.companies", group: "\u5BA2\u6237\u4E0E\u8054\u7CFB\u4EBA", label: "\u516C\u53F8", description: "\u5171\u4EAB\u516C\u53F8\u4E3B\u6863\u4E0E\u80CC\u8C03\u8D44\u6599", schema: "prospector", table: "companies", keyColumn: "id", defaultSort: "created_at", defaultDirection: "desc" },
  { id: "prospector.contacts", group: "\u5BA2\u6237\u4E0E\u8054\u7CFB\u4EBA", label: "\u8054\u7CFB\u4EBA", description: "\u4E2D\u5FC3\u8054\u7CFB\u4EBA\u4E3B\u6863\u4E0E\u8054\u7CFB\u72B6\u6001", schema: "prospector", table: "contacts", keyColumn: "id", defaultSort: "updated_at", defaultDirection: "desc" },
  { id: "prospector.crm_customers", group: "\u5BA2\u6237\u4E0E\u8054\u7CFB\u4EBA", label: "\u5BA2\u6237", description: "\u5BA2\u6237\u5BB9\u5668\u3001\u5F52\u5C5E\u3001\u6765\u6E90\u4E0E\u5173\u7CFB\u9636\u6BB5", schema: "prospector", table: "crm_customers", keyColumn: "customer_id", defaultSort: "created_at", defaultDirection: "desc" },
  { id: "prospector.crm_customer_contacts", group: "\u5BA2\u6237\u4E0E\u8054\u7CFB\u4EBA", label: "\u5BA2\u6237\u8054\u7CFB\u4EBA", description: "\u5BA2\u6237\u5BB9\u5668\u4E0E\u8054\u7CFB\u4EBA\u7684\u5F52\u5C5E\u5173\u7CFB", schema: "prospector", table: "crm_customer_contacts", keyColumn: "contact_id", defaultSort: "contact_id", defaultDirection: "asc" },
  { id: "prospector.crm_contact_assignment_requests", group: "\u534F\u4F5C\u4E0E\u8DDF\u8FDB", label: "\u7EBF\u7D22\u5206\u914D", description: "\u8054\u7CFB\u4EBA\u5206\u914D\u8BF7\u6C42\u4E0E\u63A5\u53D7\u72B6\u6001", schema: "prospector", table: "crm_contact_assignment_requests", keyColumn: "request_id", defaultSort: "created_at", defaultDirection: "desc" },
  { id: "prospector.crm_contact_shares", group: "\u534F\u4F5C\u4E0E\u8DDF\u8FDB", label: "\u8054\u7CFB\u4EBA\u5171\u4EAB", description: "\u8054\u7CFB\u4EBA\u5B57\u6BB5\u3001\u8DDF\u8FDB\u4E0E\u9636\u6BB5\u534F\u4F5C\u6388\u6743", schema: "prospector", table: "crm_contact_shares", keyColumn: "share_id", defaultSort: "created_at", defaultDirection: "desc" },
  { id: "prospector.crm_followup_tasks", group: "\u534F\u4F5C\u4E0E\u8DDF\u8FDB", label: "\u8DDF\u8FDB\u4EFB\u52A1", description: "\u5F00\u653E\u4E0E\u5DF2\u5B8C\u6210\u7684\u5BA2\u6237\u8DDF\u8FDB\u4EFB\u52A1", schema: "prospector", table: "crm_followup_tasks", keyColumn: "task_id", defaultSort: "updated_at", defaultDirection: "desc" },
  { id: "prospector.crm_opportunities", group: "\u534F\u4F5C\u4E0E\u8DDF\u8FDB", label: "\u5546\u673A", description: "\u5BA2\u6237\u5546\u673A\u3001\u9636\u6BB5\u3001\u91D1\u989D\u4E0E\u5173\u95ED\u7ED3\u679C", schema: "prospector", table: "crm_opportunities", keyColumn: "opportunity_id", defaultSort: "updated_at", defaultDirection: "desc" },
  { id: "prospector.crm_import_batches", group: "\u534F\u4F5C\u4E0E\u8DDF\u8FDB", label: "\u5BFC\u5165\u6279\u6B21", description: "\u5BA2\u6237\u5BFC\u5165\u6279\u6B21\u4E0E\u5B57\u6BB5\u6620\u5C04\uFF0C\u4E0D\u5C55\u793A\u539F\u59CB\u884C", schema: "prospector", table: "crm_import_batches", keyColumn: "batch_id", defaultSort: "created_at", defaultDirection: "desc" }
];
var COLUMN_LABELS = {
  user_id: "\u7528\u6237 ID",
  display_name: "\u59D3\u540D",
  email: "\u90AE\u7BB1",
  verified_at: "\u90AE\u7BB1\u9A8C\u8BC1\u65F6\u95F4",
  active: "\u542F\u7528",
  identity_admin: "\u8D85\u7EA7\u7BA1\u7406\u5458",
  security_revision: "\u5B89\u5168\u4FEE\u8BA2",
  management_revision: "\u7BA1\u7406\u4FEE\u8BA2",
  must_change_password: "\u5FC5\u987B\u6539\u5BC6",
  deleted_at: "\u5F52\u6863\u65F6\u95F4",
  product_id: "\u4EA7\u54C1",
  name: "\u540D\u79F0",
  connected: "\u5DF2\u8FDE\u63A5",
  description: "\u8BF4\u660E",
  role: "\u89D2\u8272",
  scope: "\u6570\u636E\u8303\u56F4",
  capabilities: "\u80FD\u529B",
  actor_id: "\u64CD\u4F5C\u4EBA",
  target_id: "\u76EE\u6807\u7528\u6237",
  action: "\u52A8\u4F5C",
  reason: "\u539F\u56E0",
  created_at: "\u521B\u5EFA\u65F6\u95F4",
  updated_at: "\u66F4\u65B0\u65F6\u95F4",
  id: "ID",
  company_id: "\u516C\u53F8 ID",
  domain: "\u57DF\u540D",
  industry: "\u884C\u4E1A",
  country: "\u56FD\u5BB6",
  size: "\u89C4\u6A21",
  backcheck_data: "\u80CC\u8C03\u8D44\u6599",
  first_name: "\u540D",
  last_name: "\u59D3",
  title: "\u804C\u4F4D / \u6807\u9898",
  phone: "\u7535\u8BDD",
  linkedin: "LinkedIn",
  client_type: "\u5BA2\u6237\u7C7B\u578B",
  language: "\u8BED\u8A00",
  stage: "\u9636\u6BB5",
  status: "\u72B6\u6001",
  tags: "\u6807\u7B7E",
  extra: "\u6269\u5C55\u5B57\u6BB5",
  assignee: "\u539F\u5F52\u5C5E",
  source: "\u6765\u6E90",
  source_detail: "\u6765\u6E90\u8BF4\u660E",
  crm_touch_status: "\u8054\u7CFB\u72B6\u6001",
  crm_contact_version: "\u8054\u7CFB\u4EBA\u7248\u672C",
  customer_id: "\u5BA2\u6237 ID",
  customer_key: "\u5BA2\u6237\u6765\u6E90\u952E",
  owner_user_id: "\u8D1F\u8D23\u4EBA",
  created_by: "\u521B\u5EFA\u4EBA",
  version: "\u7248\u672C",
  origin: "\u8EAB\u4EFD\u6765\u6E90",
  business_type: "\u4E1A\u52A1\u7C7B\u578B",
  development_restriction: "\u5F00\u53D1\u9650\u5236",
  source_created_at: "\u6765\u6E90\u521B\u5EFA\u65F6\u95F4",
  relationship_stage: "\u5173\u7CFB\u9636\u6BB5",
  stage_needs_review: "\u9636\u6BB5\u5F85\u590D\u6838",
  legacy_stage_snapshot: "\u5386\u53F2\u9636\u6BB5\u5FEB\u7167",
  contact_id: "\u8054\u7CFB\u4EBA ID",
  request_id: "\u5206\u914D\u8BF7\u6C42 ID",
  target_user_id: "\u76EE\u6807\u7528\u6237",
  notify_user_ids: "\u901A\u77E5\u7528\u6237",
  decided_at: "\u51B3\u5B9A\u65F6\u95F4",
  share_id: "\u5171\u4EAB ID",
  grantor_user_id: "\u6388\u6743\u4EBA",
  editable_fields: "\u53EF\u7F16\u8F91\u5B57\u6BB5",
  can_followup: "\u53EF\u8DDF\u8FDB",
  can_change_stage: "\u53EF\u6539\u9636\u6BB5",
  task_id: "\u4EFB\u52A1 ID",
  opportunity_id: "\u5546\u673A ID",
  due_at: "\u5230\u671F\u65F6\u95F4",
  completed_at: "\u5B8C\u6210\u65F6\u95F4",
  completed_by: "\u5B8C\u6210\u4EBA",
  feedback: "\u53CD\u9988",
  pol: "\u8D77\u8FD0\u6E2F",
  pod: "\u76EE\u7684\u6E2F",
  container_type: "\u7BB1\u578B",
  amount: "\u91D1\u989D",
  currency: "\u5E01\u79CD",
  lost_reason: "\u4E22\u5355\u539F\u56E0",
  evidence: "\u8D62\u5355\u8BC1\u636E",
  closed_at: "\u5173\u95ED\u65F6\u95F4",
  closed_by: "\u5173\u95ED\u4EBA",
  batch_id: "\u6279\u6B21 ID",
  mapping: "\u5B57\u6BB5\u6620\u5C04"
};
var SENSITIVE_COLUMN = /(?:^|_)(password|passwd|token|secret|hash|credential|challenge)(?:_|$)/i;
function findAdminDataTable(id) {
  return ADMIN_DATA_TABLES.find((table) => table.id === id);
}
function adminDataTableInfo(table) {
  return { id: table.id, group: table.group, label: table.label, description: table.description };
}
function isSafeAdminDataColumn(name) {
  return !SENSITIVE_COLUMN.test(name);
}
function adminDataColumnLabel(name) {
  return COLUMN_LABELS[name] ?? name;
}
function adminDataValueKind(type) {
  if (["smallint", "integer", "bigint", "decimal", "numeric", "real", "double precision"].includes(type))
    return "number";
  if (type === "boolean")
    return "boolean";
  if (type === "date" || type.startsWith("timestamp"))
    return "date";
  if (type === "json" || type === "jsonb")
    return "json";
  if (["text", "character varying", "character", "uuid"].includes(type))
    return "text";
  return "other";
}
function canReadAdminData(actor) {
  return actor.identityAdmin;
}

// server/adapters/postgres/admin-repository.ts
var MAX_AUDIT_ROWS = 100;
var BYTES_PER_KIBIBYTE = 1024;
var PERCENT_SCALE = 100;
var DECIMAL_PLACES = 1;
var PACKAGE_FILE = "package.json";
var DISK_PATH = process.platform === "win32" ? import_node_path2.default.parse(process.cwd()).root : "/";
var PERSON = `u.user_id AS "userId",u.display_name AS "displayName",e.email,e.verified_at IS NOT NULL AS "emailVerified",u.deleted_at AS "deletedAt",
 u.identity_admin AS "identityAdmin",u.active,u.management_revision AS revision,
 COALESCE(a.active,true) AS "accessActive",COALESCE(a.scope,CASE
  WHEN EXISTS(SELECT 1 FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active AND g.role='admin') THEN 'summary'
  WHEN EXISTS(SELECT 1 FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active AND g.role='operations') THEN 'shared' ELSE 'own' END) AS scope,a.capabilities,
 ARRAY(SELECT role FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' ORDER BY role) AS "crmRoles",
 (SELECT g.role FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='navigator' AND g.active AND g.role IN ('operations','sales') ORDER BY CASE g.role WHEN 'operations' THEN 0 ELSE 1 END LIMIT 1) AS "navigatorRole",
 COALESCE((SELECT na.active FROM public.identity_product_access na WHERE na.user_id=u.user_id AND na.product_id='navigator'),false) AS "navigatorActive"`;
function managed(row2) {
  return { ...row2, capabilities: effectiveCapabilitiesFor(row2.crmRoles, row2.capabilities) };
}
function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value2 = bytes, index = 0;
  while (value2 >= BYTES_PER_KIBIBYTE && index < units.length - 1) {
    value2 /= BYTES_PER_KIBIBYTE;
    index++;
  }
  return `${value2.toFixed(index === 0 ? 0 : DECIMAL_PLACES)} ${units[index]}`;
}
async function applicationVersion() {
  try {
    const value2 = JSON.parse(await (0, import_promises.readFile)(import_node_path2.default.resolve(process.cwd(), PACKAGE_FILE), "utf8"));
    return typeof value2.version === "string" && value2.version ? value2.version : "unknown";
  } catch {
    return "unknown";
  }
}
async function diskCheck() {
  try {
    const disk = await (0, import_promises.statfs)(DISK_PATH);
    const total = disk.blocks * disk.bsize, free = disk.bavail * disk.bsize;
    const usedPercent = total > 0 ? (total - free) / total * PERCENT_SCALE : PERCENT_SCALE;
    const state = usedPercent >= OPERATIONS_LIMITS.disk_offline_usage_percent ? "offline" : usedPercent >= OPERATIONS_LIMITS.disk_attention_usage_percent ? "attention" : "healthy";
    return { id: "disk", label: "\u670D\u52A1\u5668\u78C1\u76D8", state, value: `${usedPercent.toFixed(DECIMAL_PLACES)}%`, valueLabel: "\u5DF2\u4F7F\u7528", detail: `\u53EF\u7528 ${formatBytes(free)} / ${formatBytes(total)}` };
  } catch {
    return { id: "disk", label: "\u670D\u52A1\u5668\u78C1\u76D8", state: "not_connected", value: "\u4E0D\u53EF\u8BFB", valueLabel: "\u5DF2\u4F7F\u7528", detail: "\u5F53\u524D\u8FD0\u884C\u73AF\u5883\u672A\u63D0\u4F9B\u78C1\u76D8\u5BB9\u91CF" };
  }
}
function quoteIdentifier(value2) {
  return `"${value2.replaceAll('"', '""')}"`;
}
function databaseValue(value2) {
  if (value2 instanceof Date)
    return value2.toISOString();
  if (typeof value2 === "bigint")
    return value2.toString();
  return value2 ?? null;
}
var PostgresAdminRepository = class {
  constructor(pool, log) {
    this.pool = pool;
    this.log = log;
    assertCenterDatabasePool(pool);
  }
  async execute(action) {
    try {
      return await action();
    } catch (error) {
      const code2 = error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9]+$/.test(error.code) ? error.code : "UNKNOWN";
      this.log.write("ERROR", "management.pg", `\u6570\u636E\u5E93\u64CD\u4F5C\u5931\u8D25 code=${code2}`);
      return failure("DATABASE_ERROR", "\u7BA1\u7406\u670D\u52A1\u6682\u4E0D\u53EF\u7528");
    }
  }
  async tx(action) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await action(c);
      await c.query(r.ok ? "COMMIT" : "ROLLBACK");
      return r;
    } catch (error) {
      try {
        await c.query("ROLLBACK");
      } catch {
        this.log.write("ERROR", "management.rollback", "\u56DE\u6EDA\u5931\u8D25");
      }
      throw error;
    } finally {
      c.release();
    }
  }
  migrate() {
    return this.execute(() => this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK]);
      const hash = (0, import_node_crypto2.createHash)("sha256").update(ADMIN_SQL).digest("hex");
      const existing = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [ADMIN_VERSION]);
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== hash)
          return failure("CONFLICT", "\u7BA1\u7406\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      } else {
        await c.query(ADMIN_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [ADMIN_VERSION, hash]);
        this.log.write("INFO", "management.migrate", `\u8FC1\u79FB\u5B8C\u6210 version=${ADMIN_VERSION}`);
      }
      const lifecycleHash = (0, import_node_crypto2.createHash)("sha256").update(USER_LIFECYCLE_SQL).digest("hex");
      const lifecycle = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [USER_LIFECYCLE_VERSION]);
      if (lifecycle.rows.length && lifecycle.rows[0].checksum !== lifecycleHash)
        return failure("CONFLICT", "\u8D26\u53F7\u751F\u547D\u5468\u671F\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!lifecycle.rows.length) {
        await c.query(USER_LIFECYCLE_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [USER_LIFECYCLE_VERSION, lifecycleHash]);
        this.log.write("INFO", "management.migrate", `\u8FC1\u79FB\u5B8C\u6210 version=${USER_LIFECYCLE_VERSION}`);
      }
      const navigatorHash = (0, import_node_crypto2.createHash)("sha256").update(NAVIGATOR_ACCESS_SQL).digest("hex");
      const navigator2 = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [NAVIGATOR_ACCESS_VERSION]);
      if (navigator2.rows.length && navigator2.rows[0].checksum !== navigatorHash)
        return failure("CONFLICT", "Navigator \u6388\u6743\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!navigator2.rows.length) {
        await c.query(NAVIGATOR_ACCESS_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [NAVIGATOR_ACCESS_VERSION, navigatorHash]);
        this.log.write("INFO", "management.migrate", `\u8FC1\u79FB\u5B8C\u6210 version=${NAVIGATOR_ACCESS_VERSION}`);
      }
      const productHash = (0, import_node_crypto2.createHash)("sha256").update(NAVIGATOR_PRODUCT_SQL).digest("hex");
      const product = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [NAVIGATOR_PRODUCT_VERSION]);
      if (product.rows.length && product.rows[0].checksum !== productHash)
        return failure("CONFLICT", "Navigator \u4EA7\u54C1\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!product.rows.length) {
        await c.query(NAVIGATOR_PRODUCT_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [NAVIGATOR_PRODUCT_VERSION, productHash]);
        this.log.write("INFO", "management.migrate", `\u8FC1\u79FB\u5B8C\u6210 version=${NAVIGATOR_PRODUCT_VERSION}`);
      }
      return success(void 0);
    }));
  }
  async actor(c, hash) {
    const result2 = await c.query(`SELECT u.user_id AS "userId",u.identity_admin AS "identityAdmin",a.scope,
   COALESCE(a.active,true) AS enabled,a.capabilities,
   ARRAY(SELECT role FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active ORDER BY role) AS roles
   FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) LEFT JOIN public.identity_product_access a ON a.user_id=u.user_id AND a.product_id='crm'
   WHERE s.token_hash=$1 AND s.client='browser' AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND NOT u.must_change_password AND s.security_revision=u.security_revision`, [hash]);
    const row2 = result2.rows[0];
    if (!row2)
      return null;
    return { ...row2, scope: row2.scope ?? (row2.roles.includes("admin") ? "summary" : row2.roles.includes("operations") ? "shared" : "own"), roles: row2.enabled ? row2.roles : [], capabilities: row2.enabled ? effectiveCapabilitiesFor(row2.roles, row2.capabilities) : [] };
  }
  async read(hash, action) {
    return this.execute(() => this.tx(async (c) => {
      await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const actor = await this.actor(c, hash);
      return actor ? action(c, actor) : failure("UNAUTHORIZED", "\u7BA1\u7406\u4F1A\u8BDD\u5931\u6548");
    }));
  }
  dataTables(hash) {
    return this.read(hash, async (_c, actor) => canReadAdminData(actor) ? success(ADMIN_DATA_TABLES.map(adminDataTableInfo)) : failure("FORBIDDEN", "\u4EC5\u8D85\u7EA7\u7BA1\u7406\u5458\u53EF\u6D4F\u89C8\u4E2D\u5FC3\u6570\u636E\u5E93"));
  }
  dataPage(hash, q) {
    return this.read(hash, async (c, actor) => {
      if (!canReadAdminData(actor))
        return failure("FORBIDDEN", "\u4EC5\u8D85\u7EA7\u7BA1\u7406\u5458\u53EF\u6D4F\u89C8\u4E2D\u5FC3\u6570\u636E\u5E93");
      if (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > ADMIN_DATA_BROWSER_LIMITS.pageMax || !Number.isSafeInteger(q.offset) || q.offset < 0)
        return failure("INVALID_INPUT", "\u5206\u9875\u53C2\u6570\u65E0\u6548");
      const search = q.search.trim();
      if (search.length > ADMIN_DATA_BROWSER_LIMITS.searchMax)
        return failure("INVALID_INPUT", "\u641C\u7D22\u5185\u5BB9\u8FC7\u957F");
      const table = findAdminDataTable(q.table);
      if (!table)
        return failure("INVALID_INPUT", "\u6570\u636E\u8868\u4E0D\u5728\u53EF\u6D4F\u89C8\u8303\u56F4");
      if (q.direction !== void 0 && q.direction !== "asc" && q.direction !== "desc")
        return failure("INVALID_INPUT", "\u6392\u5E8F\u65B9\u5411\u65E0\u6548");
      const direction = q.direction ?? table.defaultDirection;
      await c.query("SELECT set_config('statement_timeout',$1,true)", [`${ADMIN_DATA_BROWSER_LIMITS.statement_timeout_seconds * 1e3}ms`]);
      const metadata = await c.query(`SELECT column_name AS "columnName",data_type AS "dataType" FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, [table.schema, table.table]);
      const safe = metadata.rows.filter((column) => isSafeAdminDataColumn(column.columnName));
      if (!safe.some((column) => column.columnName === table.keyColumn))
        return failure("NOT_FOUND", "\u6570\u636E\u8868\u5C1A\u672A\u5C31\u7EEA");
      const sort = q.sort || table.defaultSort;
      if (!safe.some((column) => column.columnName === sort))
        return failure("INVALID_INPUT", "\u6392\u5E8F\u5B57\u6BB5\u65E0\u6548");
      const searchColumns = safe.filter((column) => adminDataValueKind(column.dataType) === "text");
      if (search && !searchColumns.length)
        return failure("INVALID_INPUT", "\u5F53\u524D\u6570\u636E\u8868\u4E0D\u652F\u6301\u641C\u7D22");
      const columns = safe.map((column) => ({ key: column.columnName, label: adminDataColumnLabel(column.columnName), type: column.dataType, kind: adminDataValueKind(column.dataType), sortable: true, searchable: adminDataValueKind(column.dataType) === "text" }));
      const relation = `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}`;
      const where = search ? `WHERE (${searchColumns.map((column) => `${quoteIdentifier(column.columnName)}::text ILIKE $1`).join(" OR ")})` : "";
      const searchParams = search ? [`%${search}%`] : [];
      const count = await c.query(`SELECT count(*)::int AS n FROM ${relation} ${where}`, searchParams);
      const limitParam = searchParams.length + 1, offsetParam = searchParams.length + 2;
      const selected = await c.query(`SELECT ${safe.map((column) => quoteIdentifier(column.columnName)).join(",")} FROM ${relation} ${where} ORDER BY ${quoteIdentifier(sort)} ${direction},${quoteIdentifier(table.keyColumn)} ${direction} LIMIT $${limitParam} OFFSET $${offsetParam}`, [...searchParams, q.limit, q.offset]);
      return success({ table: adminDataTableInfo(table), columns, rows: selected.rows.map((row2) => Object.fromEntries(Object.entries(row2).map(([key, value2]) => [key, databaseValue(value2)]))), total: Number(count.rows[0]?.n ?? 0), limit: q.limit, offset: q.offset, search, sort, direction, keyColumn: table.keyColumn });
    });
  }
  users(hash, q) {
    return this.read(hash, async (c, actor) => {
      if (!actor.identityAdmin && (q.productId !== "crm" || !actor.capabilities.includes("members.read")))
        return failure("FORBIDDEN", "\u65E0\u6210\u5458\u8BFB\u53D6\u6743\u9650");
      const state = q.state ?? "active";
      if (state === "archived" && !actor.identityAdmin)
        return failure("FORBIDDEN", "\u65E0\u5F52\u6863\u8D26\u53F7\u8BFB\u53D6\u6743\u9650");
      const filter = `WHERE (($4::text='archived' AND u.deleted_at IS NOT NULL) OR ($4::text='active' AND u.deleted_at IS NULL)) AND ($1='' OR u.user_id::text=$1 OR e.email ILIKE $2 ESCAPE '\\' OR u.display_name ILIKE $2 ESCAPE '\\')
   AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id=$3 AND g.active))`;
      const p = [q.search, `%${q.search.replace(/[\\%_]/g, "\\$&")}%`, q.productId ?? null];
      const count = await c.query(`SELECT count(*)::int AS n FROM public.identity_users u JOIN public.identity_login_emails e USING(user_id) ${filter}`, [...p, state]);
      const rows = await c.query(`SELECT ${PERSON} FROM public.identity_users u JOIN public.identity_login_emails e USING(user_id) LEFT JOIN public.identity_product_access a ON a.user_id=u.user_id AND a.product_id='crm' ${filter}
    ORDER BY CASE WHEN u.identity_admin THEN 0 ELSE COALESCE((
     SELECT MIN(array_position($5::text[],g.role)) FROM public.identity_product_grants g
     WHERE g.user_id=u.user_id AND g.product_id=COALESCE($3,'crm') AND g.active
    ),array_length($5::text[],1)+1) END,u.created_at DESC,u.user_id LIMIT $6 OFFSET $7`, [...p, state, [...CRM_ROLES], q.limit, q.offset]);
      return success({ items: rows.rows.map(managed), total: count.rows[0].n });
    });
  }
  products(hash) {
    return this.read(hash, async (c, actor) => {
      const rows = await c.query('SELECT product_id AS "productId",name,connected,description FROM public.identity_products ORDER BY product_id');
      return success(rows.rows.map((row2) => ({ ...row2, capabilities: row2.productId === "crm" ? actor.capabilities : [], roles: row2.productId === "crm" ? actor.roles : [], scope: row2.productId === "crm" ? actor.scope : "own" })));
    });
  }
  dashboard(hash) {
    return this.read(hash, async (c, actor) => {
      if (!canReadManagementDashboard(actor))
        return failure("FORBIDDEN", "\u65E0\u6570\u636E\u770B\u677F\u6743\u9650");
      const [users, customers, tasks, pending, imports, deliveries, batchReceipts, eventReceipts, taskReceipts] = await Promise.all([
        c.query("SELECT count(*)::int AS n FROM public.identity_users WHERE active AND deleted_at IS NULL"),
        c.query("SELECT count(*)::int AS n,max(created_at) AS updated_at FROM crm_customers"),
        c.query("SELECT count(*)::int AS n,count(*) FILTER (WHERE due_at<=now())::int AS overdue,min(due_at) AS next_due FROM crm_followup_tasks WHERE status='open'"),
        c.query("SELECT count(*)::int AS n,count(*) FILTER (WHERE created_at < now()-$1 * interval '1 second')::int AS stale,min(created_at) AS oldest FROM public.identity_outbox o WHERE NOT EXISTS (SELECT 1 FROM crm_notification_consumed x WHERE x.event_id=o.event_id)", [DASHBOARD_LIMITS.stale_event_seconds]),
        c.query("SELECT count(*)::int AS n,max(created_at) AS updated_at FROM crm_import_batches"),
        c.query("SELECT count(*)::int AS n,max(created_at) AS updated_at FROM crm_event_deliveries"),
        c.query(`SELECT b.batch_id::text AS id,b.created_at,count(r.row_id)::int AS total,count(r.row_id) FILTER (WHERE r.status='created')::int AS created,count(r.row_id) FILTER (WHERE r.status='duplicate')::int AS duplicate,count(r.row_id) FILTER (WHERE r.status IN ('invalid','restricted_conflict'))::int AS review FROM (SELECT batch_id,created_at FROM crm_import_batches ORDER BY created_at DESC,batch_id LIMIT $1) b LEFT JOIN crm_import_rows r USING(batch_id) GROUP BY b.batch_id,b.created_at ORDER BY b.created_at DESC,b.batch_id`, [DASHBOARD_LIMITS.receipts]),
        c.query(`SELECT o.event_id::text AS id,o.created_at,x.consumed_at,(SELECT count(*)::int FROM crm_event_deliveries d WHERE d.event_id=o.event_id) AS deliveries FROM public.identity_outbox o LEFT JOIN crm_notification_consumed x USING(event_id) WHERE o.product_id='crm' AND o.customer_id IS NOT NULL ORDER BY o.created_at DESC,o.event_id LIMIT $1`, [DASHBOARD_LIMITS.receipts]),
        c.query(`SELECT t.task_id::text AS id,t.updated_at AS created_at,t.status,t.due_at,EXISTS(SELECT 1 FROM crm_task_due_receipts r WHERE r.task_id=t.task_id AND r.task_version=t.version) AS reminded FROM crm_followup_tasks t ORDER BY t.updated_at DESC,t.task_id LIMIT $1`, [DASHBOARD_LIMITS.receipts])
      ]);
      const value2 = (r) => Number(r.rows[0]?.n ?? 0);
      const iso2 = (v) => v instanceof Date ? v.toISOString() : typeof v === "string" ? new Date(v).toISOString() : null;
      const customerCount = value2(customers), taskCount = value2(tasks), pendingCount = value2(pending), overdueCount = Number(tasks.rows[0]?.overdue ?? 0), staleCount = Number(pending.rows[0]?.stale ?? 0);
      const databases = [
        { id: "identity", name: "\u8EAB\u4EFD\u6570\u636E\u533A", kind: "\u4E2D\u5FC3 PostgreSQL \xB7 public.identity_*", state: "healthy", records: value2(users), updatedAt: null, detail: "\u4E0E\u4E1A\u52A1\u533A\u5171\u7528 public schema\uFF1B\u8D26\u53F7\u8868\u4F7F\u7528 identity_ \u524D\u7F00", recordLabel: "\u542F\u7528\u8D26\u53F7" },
        { id: "crm", name: "Prospector \u4E1A\u52A1\u6570\u636E\u533A", kind: "\u4E2D\u5FC3 PostgreSQL \xB7 public", state: "healthy", records: customerCount, updatedAt: iso2(customers.rows[0]?.updated_at), detail: "\u5BA2\u6237\u3001\u8054\u7CFB\u4EBA\u3001\u8DDF\u8FDB\u4E0E\u534F\u4F5C\u4E8B\u4EF6\uFF1B\u65F6\u95F4\u4E3A\u6700\u8FD1\u5BA2\u6237\u521B\u5EFA\u65F6\u95F4", recordLabel: "\u5BA2\u6237" },
        { id: "local", name: "\u684C\u9762\u4E2A\u4EBA\u6570\u636E", kind: "SQLite", state: "not_connected", records: null, updatedAt: null, detail: "\u5C1A\u672A\u63A5\u5165\u4E2D\u5FC3\u9065\u6D4B", recordLabel: "\u8BB0\u5F55" }
      ];
      const flows = [
        { id: "import", label: "\u5BFC\u5165 \u2192 \u5BA2\u6237\u5E93", state: "healthy", records: value2(imports), updatedAt: iso2(imports.rows[0]?.updated_at), detail: "\u5DF2\u8BB0\u5F55\u7684\u4E2D\u5FC3\u5BFC\u5165\u6279\u6B21", recordLabel: "\u5BFC\u5165\u6279\u6B21", timeLabel: "\u6700\u8FD1\u5BFC\u5165", stages: ["\u6587\u4EF6\u89E3\u6790", "\u5B57\u6BB5\u6821\u9A8C", "\u5BA2\u6237\u5165\u5E93"] },
        { id: "events", label: "\u4E1A\u52A1\u4E8B\u4EF6 \u2192 \u901A\u77E5", state: staleCount > 0 ? "attention" : "healthy", records: value2(deliveries), updatedAt: iso2(deliveries.rows[0]?.updated_at), detail: pendingCount > 0 ? `\u6709 ${pendingCount} \u6761\u4E8B\u4EF6\u7B49\u5F85\u5904\u7406\uFF0C${staleCount} \u6761\u8D85\u8FC7\u4E00\u5206\u949F` : "\u5F85\u5904\u7406\u961F\u5217\u4E3A\u7A7A", recordLabel: "\u901A\u77E5\u8BB0\u5F55", timeLabel: "\u6700\u8FD1\u6295\u9012", stages: ["\u4E1A\u52A1\u4E8B\u4EF6", "\u6743\u9650\u6295\u5F71", "\u901A\u77E5\u6295\u9012"] },
        { id: "tasks", label: "\u8DDF\u8FDB\u4EFB\u52A1 \u2192 \u5230\u671F\u63D0\u9192", state: overdueCount > 0 ? "attention" : "healthy", records: taskCount, updatedAt: iso2(tasks.rows[0]?.next_due), detail: `${taskCount} \u6761\u5F00\u653E\u4EFB\u52A1\uFF0C${overdueCount} \u6761\u5DF2\u5230\u671F`, recordLabel: "\u5F00\u653E\u4EFB\u52A1", timeLabel: "\u6700\u8FD1\u5230\u671F", stages: ["\u4EFB\u52A1\u521B\u5EFA", "\u5230\u671F\u626B\u63CF", "\u63D0\u9192\u6295\u9012"] }
      ];
      const alerts = [
        ...staleCount > 0 ? [{ id: "pending-events", level: "warning", title: "\u4E8B\u4EF6\u7B49\u5F85\u8D85\u8FC7\u4E00\u5206\u949F", detail: `${staleCount} \u6761\u4E8B\u4EF6\u5C1A\u672A\u5B8C\u6210\u6D88\u8D39\uFF1B\u6D88\u8D39\u56DE\u6267\u4E0D\u7B49\u4E8E\u7528\u6237\u5DF2\u8BFB` }] : [],
        ...overdueCount > 0 ? [{ id: "open-tasks", level: "warning", title: "\u6709\u8DDF\u8FDB\u4EFB\u52A1\u5DF2\u5230\u671F", detail: `${overdueCount} \u6761\u4EFB\u52A1\u5F85\u5904\u7406` }] : [],
        { id: "local-telemetry", level: "warning", title: "\u684C\u9762\u4E2A\u4EBA\u6570\u636E\u672A\u63A5\u5165", detail: "\u90AE\u4EF6\u5E93\u3001\u8FD0\u4EF7\u955C\u50CF\u7B49\u672C\u5730\u6570\u636E\u6682\u4E0D\u7EB3\u5165\u4E2D\u5FC3\u5065\u5EB7\u5224\u65AD" }
      ];
      const receipts = [
        ...batchReceipts.rows.map((r) => ({ id: r.id, flowId: "import", createdAt: iso2(r.created_at), status: r.review ? "\u5F85\u6838\u5BF9" : r.total ? "\u5DF2\u6709\u56DE\u6267" : "\u6682\u65E0\u884C\u56DE\u6267", detail: `${r.total} \u884C\uFF1A\u65B0\u589E ${r.created}\uFF0C\u91CD\u590D ${r.duplicate}\uFF0C\u5F85\u6838\u5BF9 ${r.review}` })),
        ...eventReceipts.rows.map((r) => ({ id: r.id, flowId: "events", createdAt: iso2(r.created_at), status: r.consumed_at ? "\u5DF2\u6D88\u8D39" : "\u5F85\u6D88\u8D39", detail: `${r.deliveries} \u4EFD\u901A\u77E5\u6295\u5F71\uFF1B\u6D88\u8D39\u4E0D\u4EE3\u8868\u5DF2\u8BFB` })),
        ...taskReceipts.rows.map((r) => ({ id: r.id, flowId: "tasks", createdAt: iso2(r.created_at), status: r.status === "completed" ? "\u5DF2\u5B8C\u6210" : r.reminded ? "\u63D0\u9192\u5DF2\u5165\u961F" : "\u5F00\u653E", detail: `\u5230\u671F ${iso2(r.due_at)}\uFF1B\u5F53\u524D\u7248\u672C${r.reminded ? "\u6709" : "\u65E0"}\u63D0\u9192\u56DE\u6267` }))
      ];
      return success({ generatedAt: (/* @__PURE__ */ new Date()).toISOString(), overview: { databases: databases.length, healthy: databases.filter((row2) => row2.state === "healthy").length, activeUsers: value2(users), customers: customerCount, openTasks: taskCount, pendingEvents: pendingCount }, databases, flows, alerts, receipts });
    });
  }
  operations(hash) {
    return this.read(hash, async (c, actor) => {
      if (!canReadManagementDashboard(actor))
        return failure("FORBIDDEN", "\u65E0\u7CFB\u7EDF\u8FD0\u884C\u8BFB\u53D6\u6743\u9650");
      const [database, disk, version3] = await Promise.all([
        c.query("SELECT pg_database_size(current_database())::bigint AS bytes"),
        diskCheck(),
        applicationVersion()
      ]);
      const databaseBytes = Number(database.rows[0]?.bytes ?? 0);
      return success({
        generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        version: version3,
        uptime_seconds: Math.floor(process.uptime()),
        checks: [
          { id: "center", label: "\u4E2D\u5FC3\u670D\u52A1", state: "healthy", value: `v${version3}`, valueLabel: "\u5F53\u524D\u7248\u672C", detail: "\u4E2D\u5FC3 API \u4E0E\u7BA1\u7406\u5DE5\u4F5C\u53F0\u6B63\u5E38\u54CD\u5E94" },
          { id: "database", label: "PostgreSQL", state: "healthy", value: formatBytes(databaseBytes), valueLabel: "\u6570\u636E\u5E93\u5927\u5C0F", detail: "\u4E2D\u5FC3\u4E1A\u52A1\u5E93\u8FDE\u63A5\u6B63\u5E38" },
          disk,
          { id: "backup", label: "\u81EA\u52A8\u5907\u4EFD", state: "not_connected", value: "\u672A\u63A5\u5165", valueLabel: "\u5907\u4EFD\u76D1\u63A7", detail: "\u5C1A\u672A\u8BFB\u53D6\u670D\u52A1\u5668\u5907\u4EFD\u76EE\u5F55" }
        ]
      });
    });
  }
  sessions(hash, userId) {
    return this.read(hash, async (c, actor) => {
      if (!actor.identityAdmin && actor.userId !== userId)
        return failure("FORBIDDEN", "\u65E0\u4F1A\u8BDD\u7BA1\u7406\u6743\u9650");
      const rows = await c.query(`SELECT session_id AS "sessionId",client,created_at AS "createdAt",expires_at AS "expiresAt",(revoked_at IS NOT NULL OR expires_at<=now()) AS revoked FROM public.identity_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`, [userId, MAX_AUDIT_ROWS]);
      return success(rows.rows.map((row2) => ({ ...row2, createdAt: row2.createdAt.toISOString(), expiresAt: row2.expiresAt.toISOString() })));
    });
  }
  audit(hash, productId, userId) {
    return this.read(hash, async (c, actor) => {
      if (productId === void 0 && !actor.identityAdmin)
        return failure("FORBIDDEN", "\u65E0\u8EAB\u4EFD\u5BA1\u8BA1\u6743\u9650");
      if (productId === "navigator" && !actor.identityAdmin && !actor.capabilities.includes("audit.read"))
        return failure("FORBIDDEN", "\u65E0Navigator\u5BA1\u8BA1\u6743\u9650");
      if (productId === "crm" && !actor.capabilities.includes("audit.read"))
        return failure("FORBIDDEN", "\u65E0\u4EA7\u54C1\u5BA1\u8BA1\u6743\u9650");
      const rows = await c.query(`SELECT a.id::text,a.action,a.product_id AS "productId",a.reason,a.created_at AS "createdAt",u.display_name AS "actorName",COALESCE(t.display_name,'') AS "targetName" FROM public.identity_management_audit a JOIN public.identity_users u ON u.user_id=a.actor_id LEFT JOIN public.identity_users t ON t.user_id=a.target_id WHERE a.product_id IS NOT DISTINCT FROM $1 AND ($3::uuid IS NULL OR a.actor_id=$3::uuid OR a.target_id=$3::uuid) ORDER BY a.id DESC LIMIT $2`, [productId ?? null, MAX_AUDIT_ROWS, userId ?? null]);
      return success(rows.rows.map((row2) => ({ ...row2, createdAt: row2.createdAt.toISOString() })));
    });
  }
  mutate(hash, cmd, challenge, initialPasswordHash) {
    return this.execute(() => this.tx(async (c) => {
      if (cmd.action === "product.update" && cmd.role !== void 0)
        cmd = { ...cmd, ...productPermissionsFor(cmd.role) };
      await c.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK]);
      const actor = await this.actor(c, hash);
      if (!actor)
        return failure("UNAUTHORIZED", "\u7BA1\u7406\u4F1A\u8BDD\u5931\u6548");
      if (cmd.action === "product.update") {
        if (!actor.roles.includes("admin") || !actor.capabilities.includes("access.manage") || !actor.capabilities.includes("roles.manage"))
          return failure("FORBIDDEN", "\u65E0\u4EA7\u54C1\u6388\u6743\u7EF4\u62A4\u6743\u9650");
        const delegated = actor.identityAdmin ? capabilitiesFor(["admin", "operations", "sales", "auditor"]) : actor.capabilities;
        if (cmd.capabilities.some((cap) => !delegated.includes(cap)) || cmd.roles.includes("admin") && !actor.roles.includes("admin"))
          return failure("FORBIDDEN", "\u6388\u6743\u8D85\u8FC7\u59D4\u6258\u4E0A\u9650");
        if (cmd.userId === actor.userId && (cmd.capabilities.some((cap) => !actor.capabilities.includes(cap)) || cmd.roles.some((role) => !actor.roles.includes(role))))
          return failure("FORBIDDEN", "\u4E0D\u80FD\u6269\u5927\u672C\u4EBA\u6743\u9650");
        const scopeRank = { own: 0, shared: 1, summary: 2 };
        if (scopeRank[cmd.scope] > scopeRank[actor.scope])
          return failure("FORBIDDEN", "\u6570\u636E\u8303\u56F4\u8D85\u8FC7\u59D4\u6258\u4E0A\u9650");
      } else if (!actor.identityAdmin)
        return failure("FORBIDDEN", "\u65E0\u8EAB\u4EFD\u7BA1\u7406\u6743\u9650");
      let targetId, productId = null;
      if (cmd.action === "user.create") {
        if (!initialPasswordHash)
          return failure("INVALID_INPUT", "\u7F3A\u5C11\u521D\u59CB\u5BC6\u7801\u6458\u8981");
        const existing = await c.query(`SELECT e.user_id,u.deleted_at FROM public.identity_login_emails e JOIN public.identity_users u USING(user_id) WHERE e.email=$1 FOR UPDATE OF u`, [cmd.email]);
        if (existing.rows.length)
          return failure("CONFLICT", existing.rows[0].deleted_at ? "\u8BE5\u90AE\u7BB1\u5DF2\u5F52\u6863\uFF0C\u8BF7\u5230\u5DF2\u5F52\u6863\u8D26\u53F7\u4E2D\u6062\u590D" : "\u8BE5\u90AE\u7BB1\u5DF2\u6CE8\u518C");
        targetId = (0, import_node_crypto2.randomUUID)();
        productId = "crm";
        const { roles, scope, capabilities } = productPermissionsFor(cmd.role);
        await c.query("INSERT INTO public.identity_users(user_id,display_name,identity_admin,must_change_password) VALUES($1,$2,$3,true)", [targetId, cmd.email.split("@")[0], cmd.role === "admin"]);
        await c.query("INSERT INTO public.identity_login_emails(user_id,email) VALUES($1,$2)", [targetId, cmd.email]);
        await c.query("INSERT INTO public.identity_credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,'scrypt-v1')", [targetId, initialPasswordHash]);
        for (const role of roles)
          await c.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,'crm',$2)", [targetId, role]);
        await c.query("INSERT INTO public.identity_product_access(user_id,product_id,active,scope,capabilities) VALUES($1,'crm',true,$2,$3)", [targetId, scope, JSON.stringify(capabilities)]);
        const navigatorRole = navigatorGrantRoleFor(cmd.role);
        await c.query("INSERT INTO public.identity_product_grants(user_id,product_id,role,active) VALUES($1,'navigator',$2,true)", [targetId, navigatorRole]);
        await c.query("INSERT INTO public.identity_product_access(user_id,product_id,active,scope) VALUES($1,'navigator',true,'own')", [targetId]);
      } else if (cmd.action === "challenge.issue") {
        if (!challenge)
          return failure("INVALID_INPUT", "\u7F3A\u5C11\u7528\u9014\u7ED1\u5B9A\u6311\u6218");
        const existing = await c.query(`SELECT e.user_id,u.active,u.deleted_at,EXISTS(SELECT 1 FROM public.identity_credentials c WHERE c.user_id=e.user_id) AS credentialed FROM public.identity_login_emails e JOIN public.identity_users u USING(user_id) WHERE e.email=$1 FOR UPDATE OF u`, [cmd.email]);
        if (cmd.purpose === "activate" && existing.rows.length && (existing.rows[0].active || existing.rows[0].credentialed || existing.rows[0].deleted_at))
          return failure("CONFLICT", "\u8BE5\u90AE\u7BB1\u5DF2\u6CE8\u518C");
        if (cmd.purpose === "recover" && !existing.rows.length)
          return failure("NOT_FOUND", "\u672A\u627E\u5230\u76EE\u6807\u8EAB\u4EFD");
        if (cmd.purpose === "recover" && (!existing.rows[0].active || existing.rows[0].deleted_at))
          return failure("FORBIDDEN", "\u505C\u7528\u6216\u5DF2\u5220\u9664\u8D26\u53F7\u4E0D\u80FD\u91CD\u7F6E\u5BC6\u7801");
        targetId = existing.rows[0]?.user_id ?? (0, import_node_crypto2.randomUUID)();
        if (cmd.purpose === "activate" && !existing.rows.length) {
          await c.query("INSERT INTO public.identity_users(user_id,display_name,active) VALUES($1,$2,false)", [targetId, cmd.displayName]);
          await c.query("INSERT INTO public.identity_login_emails(user_id,email) VALUES($1,$2)", [targetId, cmd.email]);
        }
        await c.query("UPDATE public.identity_management_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL", [targetId]);
        await c.query("INSERT INTO public.identity_management_challenges(token_hash,user_id,purpose,issuer_id,email,expires_at) VALUES($1,$2,$3,$4,$5,$6)", [challenge.tokenHash, targetId, cmd.purpose, actor.userId, cmd.email, challenge.expiresAt]);
        if (cmd.purpose === "recover") {
          await c.query("UPDATE public.identity_users SET security_revision=security_revision+1,management_revision=management_revision+1 WHERE user_id=$1", [targetId]);
          await c.query("UPDATE public.identity_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [targetId]);
        }
      } else {
        targetId = cmd.userId;
        const target = await c.query("SELECT active,identity_admin,management_revision,deleted_at FROM public.identity_users WHERE user_id=$1 FOR UPDATE", [targetId]);
        if (!target.rows.length || target.rows[0].deleted_at && cmd.action !== "user.restore")
          return failure("NOT_FOUND", "\u76EE\u6807\u7528\u6237\u4E0D\u5B58\u5728\u6216\u5DF2\u5220\u9664");
        if ("revision" in cmd && target.rows[0].management_revision !== cmd.revision)
          return failure("CONFLICT", "\u8D44\u6599\u5DF2\u66F4\u65B0\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5");
        if (cmd.action === "user.delete") {
          if (targetId === actor.userId)
            return failure("FORBIDDEN", "\u4E0D\u80FD\u5220\u9664\u5F53\u524D\u767B\u5F55\u8D26\u53F7");
          if (target.rows[0].active && target.rows[0].identity_admin) {
            const count = await c.query(`SELECT count(*)::int AS n FROM public.identity_users u JOIN public.identity_credentials c USING(user_id) JOIN public.identity_login_emails e USING(user_id) WHERE u.active AND u.identity_admin AND u.deleted_at IS NULL`);
            if (count.rows[0].n <= 1)
              return failure("CONFLICT", "\u5FC5\u987B\u4FDD\u7559\u81F3\u5C11\u4E00\u540D\u6709\u6548\u8D85\u7EA7\u7BA1\u7406\u5458");
          }
          const owned = await c.query("SELECT 1 FROM crm_customers WHERE owner_user_id=$1 LIMIT 1", [targetId]);
          if (owned.rows.length)
            return failure("CONFLICT", "\u8BE5\u7528\u6237\u4ECD\u6709\u8D1F\u8D23\u7684\u7EBF\u7D22\uFF0C\u8BF7\u5148\u8F6C\u4EA4");
          const assignmentTable = await c.query("SELECT to_regclass('crm_contact_assignment_requests') AS relation");
          if (assignmentTable.rows[0].relation) {
            const requests = await c.query("SELECT 1 FROM crm_contact_assignment_requests WHERE status IN ('pending','accepted') AND (actor_id=$1 OR target_user_id=$1) LIMIT 1", [targetId]);
            if (requests.rows.length)
              return failure("CONFLICT", "\u8BE5\u7528\u6237\u4ECD\u6709\u6709\u6548\u8054\u7CFB\u4EBA\u5206\u914D\uFF0C\u8BF7\u5148\u5904\u7406\u5206\u914D\u5F52\u5C5E");
          }
          await c.query("UPDATE public.identity_users SET deleted_at=now(),active=false,security_revision=security_revision+1,management_revision=management_revision+1 WHERE user_id=$1", [targetId]);
          await c.query("UPDATE public.identity_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [targetId]);
          await c.query("UPDATE public.identity_management_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL", [targetId]);
        } else if (cmd.action === "user.restore") {
          if (!target.rows[0].deleted_at)
            return failure("CONFLICT", "\u76EE\u6807\u8D26\u53F7\u672A\u5F52\u6863");
          if (!initialPasswordHash)
            return failure("INVALID_INPUT", "\u7F3A\u5C11\u6062\u590D\u5BC6\u7801\u6458\u8981");
          await c.query("UPDATE public.identity_users SET active=true,deleted_at=NULL,must_change_password=true,security_revision=security_revision+1,management_revision=management_revision+1 WHERE user_id=$1", [targetId]);
          await c.query(`INSERT INTO public.identity_credentials(user_id,password_hash,hash_scheme,changed_at) VALUES($1,$2,'scrypt-v1',now())
      ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,hash_scheme=EXCLUDED.hash_scheme,changed_at=now()`, [targetId, initialPasswordHash]);
          await c.query("UPDATE public.identity_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1", [targetId]);
          await c.query("UPDATE public.identity_management_challenges SET consumed_at=COALESCE(consumed_at,now()) WHERE user_id=$1", [targetId]);
        } else if (cmd.action === "user.reset-password") {
          if (!challenge || challenge.userId !== targetId || challenge.purpose !== "recover")
            return failure("INVALID_INPUT", "\u7F3A\u5C11\u8D26\u53F7\u7ED1\u5B9A\u6311\u6218");
          if (!target.rows[0].active)
            return failure("FORBIDDEN", "\u505C\u7528\u8D26\u53F7\u4E0D\u80FD\u91CD\u7F6E\u5BC6\u7801");
          const email3 = await c.query("SELECT email FROM public.identity_login_emails WHERE user_id=$1", [targetId]);
          if (!email3.rows.length)
            return failure("NOT_FOUND", "\u76EE\u6807\u7528\u6237\u90AE\u7BB1\u4E0D\u5B58\u5728");
          await c.query("UPDATE public.identity_management_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL", [targetId]);
          await c.query("INSERT INTO public.identity_management_challenges(token_hash,user_id,purpose,issuer_id,email,expires_at) VALUES($1,$2,'recover',$3,$4,$5)", [challenge.tokenHash, targetId, actor.userId, email3.rows[0].email, challenge.expiresAt]);
          await c.query("UPDATE public.identity_users SET security_revision=security_revision+1,management_revision=management_revision+1 WHERE user_id=$1", [targetId]);
          await c.query("UPDATE public.identity_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [targetId]);
        } else if (cmd.action === "user.update") {
          if (cmd.active && !(await c.query("SELECT 1 FROM public.identity_credentials WHERE user_id=$1", [targetId])).rows.length)
            return failure("CONFLICT", "\u5F85\u6FC0\u6D3B\u8EAB\u4EFD\u5FC5\u987B\u5148\u4F7F\u7528\u6FC0\u6D3B\u94FE\u63A5\u8BBE\u7F6E\u5BC6\u7801");
          if (targetId === actor.userId && cmd.identityAdmin && !target.rows[0].identity_admin)
            return failure("FORBIDDEN", "\u4E0D\u80FD\u4E3A\u672C\u4EBA\u63D0\u6743");
          if (target.rows[0].active && target.rows[0].identity_admin && (!cmd.active || !cmd.identityAdmin)) {
            const count = await c.query(`SELECT count(*)::int AS n FROM public.identity_users u JOIN public.identity_credentials c USING(user_id) JOIN public.identity_login_emails e USING(user_id) WHERE u.active AND u.identity_admin`);
            if (count.rows[0].n <= 1)
              return failure("CONFLICT", "\u5FC5\u987B\u4FDD\u7559\u81F3\u5C11\u4E00\u540D\u6709\u6548\u8D85\u7EA7\u7BA1\u7406\u5458");
          }
          await c.query("UPDATE public.identity_users SET active=$2,identity_admin=$3,management_revision=management_revision+1,security_revision=security_revision+1 WHERE user_id=$1", [targetId, cmd.active, cmd.identityAdmin]);
          await c.query("UPDATE public.identity_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [targetId]);
          await c.query("UPDATE public.identity_management_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL", [targetId]);
        } else if (cmd.action === "product.update") {
          productId = "crm";
          await c.query("DELETE FROM public.identity_product_grants WHERE user_id=$1 AND product_id=$2", [targetId, productId]);
          for (const role of cmd.roles)
            await c.query("INSERT INTO public.identity_product_grants(user_id,product_id,role,active) VALUES($1,$2,$3,$4)", [targetId, productId, role, cmd.active]);
          await c.query(`INSERT INTO public.identity_product_access(user_id,product_id,active,scope,capabilities) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,product_id) DO UPDATE SET active=EXCLUDED.active,scope=EXCLUDED.scope,capabilities=EXCLUDED.capabilities`, [targetId, productId, cmd.active, cmd.scope, JSON.stringify(cmd.capabilities)]);
          await c.query("UPDATE public.identity_users SET management_revision=management_revision+1 WHERE user_id=$1", [targetId]);
        } else if (cmd.action === "navigator.update") {
          if (target.rows[0].identity_admin)
            return failure("FORBIDDEN", "\u4E2D\u5FC3\u8D85\u7EA7\u7BA1\u7406\u5458\u81EA\u52A8\u62E5\u6709 Navigator \u7BA1\u7406\u6743\u9650");
          productId = "navigator";
          await c.query("DELETE FROM public.identity_product_grants WHERE user_id=$1 AND product_id='navigator'", [targetId]);
          await c.query("INSERT INTO public.identity_product_grants(user_id,product_id,role,active) VALUES($1,'navigator',$2,true)", [targetId, cmd.role]);
          await c.query("INSERT INTO public.identity_product_access(user_id,product_id,active,scope) VALUES($1,'navigator',$2,'own') ON CONFLICT(user_id,product_id) DO UPDATE SET active=EXCLUDED.active", [targetId, cmd.active]);
          await c.query("UPDATE public.identity_users SET management_revision=management_revision+1 WHERE user_id=$1", [targetId]);
        } else {
          const revoked = await c.query("UPDATE public.identity_sessions SET revoked_at=now() WHERE user_id=$1 AND session_id=$2 AND revoked_at IS NULL RETURNING session_id", [targetId, cmd.sessionId]);
          if (!revoked.rows.length)
            return failure("NOT_FOUND", "\u6709\u6548\u4F1A\u8BDD\u4E0D\u5B58\u5728");
        }
      }
      await c.query("INSERT INTO public.identity_management_audit(actor_id,target_id,action,product_id,reason) VALUES($1,$2,$3,$4,$5)", [actor.userId, targetId, cmd.action, productId, cmd.reason]);
      await c.query(`INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision) SELECT $2,user_id,$3,management_revision FROM public.identity_users WHERE user_id=$1`, [targetId, cmd.action, productId]);
      return success(void 0);
    }));
  }
  consume(hash, passwordHash) {
    return this.execute(() => this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK]);
      const challenges = await c.query(`SELECT c.* FROM public.identity_management_challenges c JOIN public.identity_users issuer ON issuer.user_id=c.issuer_id WHERE c.token_hash=$1 AND c.consumed_at IS NULL AND c.expires_at>now() AND issuer.active AND issuer.identity_admin FOR UPDATE OF c`, [hash]);
      const challenge = challenges.rows[0];
      if (!challenge)
        return failure("UNAUTHORIZED", "\u94FE\u63A5\u5DF2\u5931\u6548\u6216\u5DF2\u4F7F\u7528");
      const users = await c.query("SELECT u.active,u.deleted_at,e.email FROM public.identity_users u JOIN public.identity_login_emails e USING(user_id) WHERE u.user_id=$1 FOR UPDATE OF u", [challenge.user_id]);
      if (!users.rows.length || users.rows[0].email !== challenge.email)
        return failure("CONFLICT", "\u8EAB\u4EFD\u4FE1\u606F\u5DF2\u53D8\u5316");
      if (users.rows[0].deleted_at)
        return failure("FORBIDDEN", "\u5DF2\u5220\u9664\u8D26\u53F7\u4E0D\u80FD\u6FC0\u6D3B\u6216\u91CD\u7F6E\u5BC6\u7801");
      if (challenge.purpose === "recover" && !users.rows[0].active)
        return failure("FORBIDDEN", "\u505C\u7528\u8D26\u53F7\u4E0D\u80FD\u901A\u8FC7\u5BC6\u7801\u6062\u590D\u91CD\u65B0\u542F\u7528");
      await c.query(`INSERT INTO public.identity_credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,'scrypt-v1') ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,changed_at=now()`, [challenge.user_id, passwordHash]);
      await c.query(`UPDATE public.identity_users SET active=true,must_change_password=false,security_revision=security_revision+1,management_revision=management_revision+1 WHERE user_id=$1`, [challenge.user_id]);
      await c.query("UPDATE public.identity_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [challenge.user_id]);
      await c.query("UPDATE public.identity_management_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL", [challenge.user_id]);
      await c.query(`INSERT INTO public.identity_management_audit(actor_id,target_id,action,reason) VALUES($1,$2,$3,'\u7BA1\u7406\u6311\u6218\u5DF2\u6D88\u8D39\uFF1B\u90AE\u7BB1\u672A\u9A8C\u8BC1')`, [challenge.issuer_id, challenge.user_id, `challenge.${challenge.purpose}`]);
      await c.query(`INSERT INTO public.identity_outbox(event_type,user_id,revision) SELECT 'identity.password.changed',user_id,management_revision FROM public.identity_users WHERE user_id=$1`, [challenge.user_id]);
      return success(void 0);
    }));
  }
};

// server/adapters/postgres/password-schema.ts
var PASSWORD_SCHEMA_VERSION = "004-mandatory-password-change-public";
var PASSWORD_SCHEMA_LOCK = 19041004;
var PASSWORD_SCHEMA_SQL = `ALTER TABLE public.identity_users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;`;

// server/adapters/postgres/desktop-session-schema.ts
var DESKTOP_SCHEMA_VERSION = "007-desktop-session-rotation-public";
var DESKTOP_SCHEMA_LOCK = 19041007;
var DESKTOP_SCHEMA_SQL = `
CREATE TABLE public.identity_desktop_refresh_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  session_id uuid NOT NULL REFERENCES public.identity_sessions(session_id),
  absolute_expires_at timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (idle_expires_at <= absolute_expires_at)
);
CREATE INDEX idx_desktop_refresh_session ON public.identity_desktop_refresh_tokens(session_id);
`;

// server/adapters/postgres/account-profile-schema.ts
var ACCOUNT_PROFILE_SCHEMA_VERSION = "026-unified-account-profile-public";
var ACCOUNT_PROFILE_SCHEMA_LOCK = 19041026;
var ACCOUNT_PROFILE_SCHEMA_SQL = `
CREATE TABLE public.identity_user_profiles (
  user_id uuid PRIMARY KEY REFERENCES public.identity_users(user_id) ON DELETE CASCADE,
  avatar_id text NOT NULL DEFAULT 'default' CHECK (char_length(avatar_id) BETWEEN 1 AND 64),
  bio text NOT NULL DEFAULT '' CHECK (char_length(bio) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.identity_login_aliases (
  alias text PRIMARY KEY CHECK (alias = lower(btrim(alias)) AND char_length(alias) BETWEEN 1 AND 128),
  user_id uuid NOT NULL REFERENCES public.identity_users(user_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_identity_login_aliases_user ON public.identity_login_aliases(user_id);
`;

// server/adapters/postgres/account-growth-schema.ts
var ACCOUNT_GROWTH_SCHEMA_VERSION = "027-unified-account-growth-public";
var ACCOUNT_GROWTH_SCHEMA_LOCK = 19041027;
var ACCOUNT_GROWTH_SCHEMA_SQL = `
CREATE TABLE public.identity_account_experience_events (
  event_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.identity_users(user_id) ON DELETE CASCADE,
  source_product text NOT NULL CHECK (btrim(source_product) <> ''),
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  subject_key text NOT NULL CHECK (btrim(subject_key) <> ''),
  points integer NOT NULL CHECK (points > 0),
  rule_version integer NOT NULL CHECK (rule_version > 0),
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_product, event_type, subject_key)
);
CREATE INDEX idx_identity_growth_events_user_time
  ON public.identity_account_experience_events(user_id, occurred_at DESC, event_id);
CREATE TABLE public.identity_account_growth_projection (
  user_id uuid PRIMARY KEY REFERENCES public.identity_users(user_id) ON DELETE CASCADE,
  total_xp integer NOT NULL DEFAULT 0 CHECK (total_xp >= 0),
  cycle integer NOT NULL DEFAULT 1 CHECK (cycle > 0),
  level integer NOT NULL DEFAULT 1 CHECK (level > 0),
  today_xp integer NOT NULL DEFAULT 0 CHECK (today_xp >= 0),
  today_key date,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

// server/adapters/postgres/password-compat-schema.ts
var PASSWORD_COMPAT_SCHEMA_VERSION = "028-legacy-pbkdf2-compat-public";
var PASSWORD_COMPAT_SCHEMA_LOCK = 19041028;
var PASSWORD_COMPAT_SCHEMA_SQL = `
ALTER TABLE public.identity_credentials DROP CONSTRAINT IF EXISTS identity_credentials_hash_scheme_check;
ALTER TABLE public.identity_credentials ADD CONSTRAINT identity_credentials_hash_scheme_check
  CHECK (hash_scheme IN ('scrypt-v1','pbkdf2_sha256'));
`;

// server/adapters/postgres/legacy-account-mapping-schema.ts
var LEGACY_ACCOUNT_MAPPING_SCHEMA_VERSION = "029-legacy-account-mapping-public";
var LEGACY_ACCOUNT_MAPPING_SCHEMA_LOCK = 19041029;
var LEGACY_ACCOUNT_MAPPING_SCHEMA_SQL = `
CREATE TABLE public.identity_legacy_account_mappings (
  source_product text NOT NULL CHECK (source_product = 'navigator'),
  legacy_user_id text NOT NULL CHECK (btrim(legacy_user_id) <> ''),
  legacy_login_alias text NOT NULL CHECK (legacy_login_alias = lower(btrim(legacy_login_alias))),
  center_user_id uuid REFERENCES public.identity_users(user_id),
  status text NOT NULL CHECK (status IN ('pending','matched','needs_review','migrated','rejected')),
  requires_password_reset boolean NOT NULL DEFAULT true,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_product, legacy_user_id),
  UNIQUE (source_product, legacy_login_alias)
);
CREATE INDEX idx_identity_legacy_mapping_center_user ON public.identity_legacy_account_mappings(center_user_id);
CREATE INDEX idx_identity_legacy_mapping_status ON public.identity_legacy_account_mappings(source_product, status);
`;

// server/core/account-growth.ts
var GROWTH_SOURCE_PRODUCTS = ["navigator", "crm"];
var GROWTH_EVENT_RULES = {
  daily_quote_search: { points: 2, dailyCap: 30 },
  daily_effective_search: { points: 18, dailyCap: 30 },
  daily_review_activity: { points: 18, dailyCap: 30 },
  pending_approved: { points: 2, dailyCap: null },
  pending_correction_approved: { points: 6, dailyCap: null },
  daily_governance_activity: { points: 6, dailyCap: 30 },
  governance_item_completed: { points: 6, dailyCap: 30 }
};
function growthEventRule(sourceProduct, eventType) {
  return sourceProduct === "navigator" ? GROWTH_EVENT_RULES[eventType] ?? null : null;
}
function isGrowthEventInput(value2) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
    return false;
  const event3 = value2;
  return nonEmpty(event3.eventId) && event3.eventId.length <= 128 && GROWTH_SOURCE_PRODUCTS.includes(event3.sourceProduct) && nonEmpty(event3.eventType) && event3.eventType.length <= 80 && nonEmpty(event3.subjectKey) && event3.subjectKey.length <= 256 && Number.isInteger(event3.points) && event3.points >= 1 && event3.points <= 1e3 && Number.isInteger(event3.ruleVersion) && event3.ruleVersion >= 1 && typeof event3.occurredAt === "string" && !Number.isNaN(Date.parse(event3.occurredAt));
}
var GROWTH_LEVELS_PER_CYCLE = 50;
var GROWTH_LEVEL_BASE_XP = 12;
var GROWTH_LEVEL_MAX_XP = 30;
function growthLevelCost(level) {
  const index = Math.max(0, Math.min(GROWTH_LEVELS_PER_CYCLE - 1, level - 1));
  return GROWTH_LEVEL_BASE_XP + Math.floor(index * (GROWTH_LEVEL_MAX_XP - GROWTH_LEVEL_BASE_XP) / (GROWTH_LEVELS_PER_CYCLE - 1));
}
var GROWTH_LEVEL_COSTS = Array.from({ length: GROWTH_LEVELS_PER_CYCLE }, (_, index) => growthLevelCost(index + 1));
var GROWTH_XP_PER_CYCLE = GROWTH_LEVEL_COSTS.reduce((sum, value2) => sum + value2, 0);
function growthSummary(totalXp, todayXp = 0, todayKey = null) {
  const total = Math.max(0, Math.trunc(totalXp));
  const cycle = Math.floor(total / GROWTH_XP_PER_CYCLE) + 1;
  const withinCycle = total % GROWTH_XP_PER_CYCLE;
  let level = 1;
  let levelStartInCycle = 0;
  for (let candidate = 1; candidate <= GROWTH_LEVELS_PER_CYCLE; candidate++) {
    const cost = growthLevelCost(candidate);
    if (withinCycle < levelStartInCycle + cost) {
      level = candidate;
      break;
    }
    levelStartInCycle += cost;
  }
  const levelCost = growthLevelCost(level);
  const levelProgress = withinCycle - levelStartInCycle;
  const levelStart = (cycle - 1) * GROWTH_XP_PER_CYCLE + levelStartInCycle;
  return {
    totalXp: total,
    cycle,
    level,
    levelName: `\u7B2C${cycle}\u5FAA\u73AF`,
    levelStart,
    nextThreshold: levelStart + levelCost,
    levelProgress,
    levelCost,
    cycleStart: (cycle - 1) * GROWTH_XP_PER_CYCLE,
    cycleEnd: cycle * GROWTH_XP_PER_CYCLE,
    cycleXp: GROWTH_XP_PER_CYCLE,
    todayAwarded: todayXp > 0,
    todayXp: Math.max(0, Math.trunc(todayXp)),
    todayKey
  };
}
function nonEmpty(value2) {
  return typeof value2 === "string" && value2.trim().length > 0;
}

// server/adapters/postgres/auth-repository.ts
var IDENTITY_COLUMNS = `u.user_id AS "userId",u.display_name AS "displayName",e.email,
  (e.verified_at IS NOT NULL) AS "emailVerified",u.identity_admin AS "identityAdmin",u.must_change_password AS "mustChangePassword",
  (SELECT a.capabilities FROM public.identity_product_access a WHERE a.user_id=u.user_id AND a.product_id='crm') AS "crmCapabilities",
  ARRAY(SELECT g.role FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active
    AND NOT EXISTS(SELECT 1 FROM public.identity_product_access a WHERE a.user_id=u.user_id AND a.product_id='crm' AND NOT a.active) ORDER BY g.role) AS "crmRoles"`;
var SESSION_FILTER = `s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
  AND u.active AND s.security_revision=u.security_revision`;
var GROWTH_RULE_VERSION = 2;
function profileFromRow(row2) {
  if (!row2)
    return null;
  return {
    userId: String(row2.userId),
    displayName: String(row2.displayName),
    avatarId: String(row2.avatarId),
    bio: String(row2.bio),
    growth: row2.totalXp == null ? null : growthSummary(Number(row2.totalXp), Number(row2.todayXp), row2.todayKey)
  };
}
function stableGrowthEventId(userId, sourceProduct, sourceEventId) {
  const bytes = (0, import_node_crypto3.createHash)("sha256").update(`${sourceProduct}:${userId}:${sourceEventId}`).digest().subarray(0, 16);
  bytes[6] = bytes[6] & 15 | 80;
  bytes[8] = bytes[8] & 63 | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function noGrowthAward(summary) {
  if (!summary)
    throw new Error("growth summary missing");
  return { awarded: false, awardedPoints: 0, summary };
}
function code(error) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9]+$/.test(error.code) ? error.code : "UNKNOWN";
}
var PostgresAuthRepository = class {
  constructor(pool, log) {
    this.pool = pool;
    this.log = log;
    assertCenterDatabasePool(pool);
    pool.on("error", (error) => log.write("ERROR", "identity.pg.pool", `\u8FDE\u63A5\u9519\u8BEF code=${code(error)}`));
  }
  async execute(action) {
    try {
      return await action();
    } catch (error) {
      this.log.write("ERROR", "identity.pg", `\u6570\u636E\u5E93\u64CD\u4F5C\u5931\u8D25 code=${code(error)}`);
      return failure("DATABASE_ERROR", "\u8EAB\u4EFD\u670D\u52A1\u6682\u4E0D\u53EF\u7528");
    }
  }
  async tx(action) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result2 = await action(client);
      await client.query(result2.ok ? "COMMIT" : "ROLLBACK");
      return result2;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollback) {
        this.log.write("ERROR", "identity.pg.rollback", `\u56DE\u6EDA\u5931\u8D25 code=${code(rollback)}`);
      }
      throw error;
    } finally {
      client.release();
    }
  }
  migrate() {
    return this.execute(() => this.tx(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [AUTH_SCHEMA_LOCK]);
      const checksum = (0, import_node_crypto3.createHash)("sha256").update(AUTH_SCHEMA_SQL).digest("hex");
      const existing = await client.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [AUTH_SCHEMA_VERSION]);
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum)
          return failure("CONFLICT", "\u8EAB\u4EFD\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4\uFF0C\u62D2\u7EDD\u8986\u76D6");
      } else {
        await client.query(AUTH_SCHEMA_SQL);
        await client.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [AUTH_SCHEMA_VERSION, checksum]);
        this.log.write("INFO", "identity.pg.migrate", `\u8FC1\u79FB\u5B8C\u6210 version=${AUTH_SCHEMA_VERSION}`);
      }
      return success(void 0);
    })).then(async (result2) => result2.ok ? new PostgresAdminRepository(this.pool, this.log).migrate() : result2).then(async (result2) => {
      if (!result2.ok)
        return result2;
      return this.execute(() => this.tx(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [PASSWORD_SCHEMA_LOCK]);
        const checksum = (0, import_node_crypto3.createHash)("sha256").update(PASSWORD_SCHEMA_SQL).digest("hex");
        const existing = await client.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [PASSWORD_SCHEMA_VERSION]);
        if (existing.rows.length && existing.rows[0].checksum !== checksum)
          return failure("CONFLICT", "\u6539\u5BC6\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
        if (!existing.rows.length) {
          await client.query(PASSWORD_SCHEMA_SQL);
          await client.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [PASSWORD_SCHEMA_VERSION, checksum]);
        }
        return success(void 0);
      }));
    }).then(async (result2) => {
      if (!result2.ok)
        return result2;
      return this.execute(() => this.tx(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [DESKTOP_SCHEMA_LOCK]);
        const checksum = (0, import_node_crypto3.createHash)("sha256").update(DESKTOP_SCHEMA_SQL).digest("hex");
        const existing = await client.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [DESKTOP_SCHEMA_VERSION]);
        if (existing.rows.length && existing.rows[0].checksum !== checksum)
          return failure("CONFLICT", "\u684C\u9762\u4F1A\u8BDD\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
        if (!existing.rows.length) {
          await client.query(DESKTOP_SCHEMA_SQL);
          await client.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [DESKTOP_SCHEMA_VERSION, checksum]);
        }
        return success(void 0);
      }));
    }).then(async (result2) => {
      if (!result2.ok)
        return result2;
      return this.execute(() => this.tx(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [ACCOUNT_PROFILE_SCHEMA_LOCK]);
        const checksum = (0, import_node_crypto3.createHash)("sha256").update(ACCOUNT_PROFILE_SCHEMA_SQL).digest("hex");
        const existing = await client.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [ACCOUNT_PROFILE_SCHEMA_VERSION]);
        if (existing.rows.length && existing.rows[0].checksum !== checksum)
          return failure("CONFLICT", "\u8D26\u53F7\u8D44\u6599\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
        if (!existing.rows.length) {
          await client.query(ACCOUNT_PROFILE_SCHEMA_SQL);
          await client.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [ACCOUNT_PROFILE_SCHEMA_VERSION, checksum]);
          this.log.write("INFO", "identity.pg.migrate", `\u8FC1\u79FB\u5B8C\u6210 version=${ACCOUNT_PROFILE_SCHEMA_VERSION}`);
        }
        return success(void 0);
      }));
    }).then(async (result2) => {
      if (!result2.ok)
        return result2;
      return this.execute(() => this.tx(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [ACCOUNT_GROWTH_SCHEMA_LOCK]);
        const checksum = (0, import_node_crypto3.createHash)("sha256").update(ACCOUNT_GROWTH_SCHEMA_SQL).digest("hex");
        const existing = await client.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [ACCOUNT_GROWTH_SCHEMA_VERSION]);
        if (existing.rows.length && existing.rows[0].checksum !== checksum)
          return failure("CONFLICT", "\u8D26\u53F7\u6210\u957F\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
        if (!existing.rows.length) {
          await client.query(ACCOUNT_GROWTH_SCHEMA_SQL);
          await client.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [ACCOUNT_GROWTH_SCHEMA_VERSION, checksum]);
          this.log.write("INFO", "identity.pg.migrate", `\u8FC1\u79FB\u5B8C\u6210 version=${ACCOUNT_GROWTH_SCHEMA_VERSION}`);
        }
        return success(void 0);
      }));
    }).then(async (result2) => {
      if (!result2.ok)
        return result2;
      return this.execute(() => this.tx(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [PASSWORD_COMPAT_SCHEMA_LOCK]);
        const checksum = (0, import_node_crypto3.createHash)("sha256").update(PASSWORD_COMPAT_SCHEMA_SQL).digest("hex");
        const existing = await client.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [PASSWORD_COMPAT_SCHEMA_VERSION]);
        if (existing.rows.length && existing.rows[0].checksum !== checksum)
          return failure("CONFLICT", "\u65E7\u5BC6\u7801\u517C\u5BB9\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
        if (!existing.rows.length) {
          await client.query(PASSWORD_COMPAT_SCHEMA_SQL);
          await client.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [PASSWORD_COMPAT_SCHEMA_VERSION, checksum]);
          this.log.write("INFO", "identity.pg.migrate", `\u8FC1\u79FB\u5B8C\u6210 version=${PASSWORD_COMPAT_SCHEMA_VERSION}`);
        }
        return success(void 0);
      }));
    }).then(async (result2) => {
      if (!result2.ok)
        return result2;
      return this.execute(() => this.tx(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock($1)", [LEGACY_ACCOUNT_MAPPING_SCHEMA_LOCK]);
        const checksum = (0, import_node_crypto3.createHash)("sha256").update(LEGACY_ACCOUNT_MAPPING_SCHEMA_SQL).digest("hex");
        const existing = await client.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [LEGACY_ACCOUNT_MAPPING_SCHEMA_VERSION]);
        if (existing.rows.length && existing.rows[0].checksum !== checksum)
          return failure("CONFLICT", "\u65E7\u8D26\u53F7\u6620\u5C04\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
        if (!existing.rows.length) {
          await client.query(LEGACY_ACCOUNT_MAPPING_SCHEMA_SQL);
          await client.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [LEGACY_ACCOUNT_MAPPING_SCHEMA_VERSION, checksum]);
          this.log.write("INFO", "identity.pg.migrate", `\u8FC1\u79FB\u5B8C\u6210 version=${LEGACY_ACCOUNT_MAPPING_SCHEMA_VERSION}`);
        }
        return success(void 0);
      }));
    });
  }
  ensureFixture(input) {
    return this.execute(() => this.tx(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [AUTH_SCHEMA_LOCK]);
      const existing = await client.query("SELECT user_id FROM public.identity_login_emails WHERE email=$1", [input.email]);
      if (existing.rows.length)
        return existing.rows[0].user_id === input.userId ? success(void 0) : failure("CONFLICT", "\u6D4B\u8BD5\u90AE\u7BB1\u5DF2\u6709\u5176\u4ED6\u8EAB\u4EFD\uFF0C\u4FDD\u7559\u73B0\u72B6");
      const created = await client.query("INSERT INTO public.identity_users(user_id,display_name,identity_admin,must_change_password) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING user_id", [input.userId, input.displayName, input.identityAdmin, input.mustChangePassword ?? false]);
      if (!created.rows.length)
        return failure("CONFLICT", "\u6D4B\u8BD5\u8EAB\u4EFD\u5DF2\u5B58\u5728\u4F46\u90AE\u7BB1\u4E0D\u5339\u914D");
      await client.query("INSERT INTO public.identity_login_emails(user_id,email) VALUES($1,$2)", [input.userId, input.email]);
      await client.query("INSERT INTO public.identity_credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,'scrypt-v1')", [input.userId, input.passwordHash]);
      for (const role of input.crmRoles)
        await client.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,'crm',$2)", [input.userId, role]);
      await client.query("INSERT INTO public.identity_audit(user_id,event) VALUES($1,'fixture')", [input.userId]);
      return success(void 0);
    }));
  }
  createSalesAccount(input) {
    return this.execute(() => this.tx(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK]);
      const existing = await client.query("SELECT e.user_id,u.deleted_at FROM public.identity_login_emails e JOIN public.identity_users u USING(user_id) WHERE e.email=$1 FOR UPDATE OF u", [input.email]);
      if (existing.rows.length)
        return failure("CONFLICT", existing.rows[0].deleted_at ? "\u8BE5\u90AE\u7BB1\u5DF2\u5F52\u6863\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u6062\u590D\u8D26\u53F7" : "\u8BE5\u90AE\u7BB1\u5DF2\u6CE8\u518C");
      const userId = (0, import_node_crypto3.randomUUID)();
      await client.query("INSERT INTO public.identity_users(user_id,display_name,identity_admin) VALUES($1,$2,false)", [userId, input.email.split("@")[0]]);
      await client.query("INSERT INTO public.identity_login_emails(user_id,email,verified_at) VALUES($1,$2,NULL)", [userId, input.email]);
      await client.query("INSERT INTO public.identity_credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,'scrypt-v1')", [userId, input.passwordHash]);
      for (const product of ["crm", "navigator"])
        await client.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,$2,'sales')", [userId, product]);
      for (const product of ["crm", "navigator"])
        await client.query("INSERT INTO public.identity_product_access(user_id,product_id,scope) VALUES($1,$2,'own')", [userId, product]);
      const reason = "\u90AE\u7BB1\u81EA\u52A9\u6CE8\u518C\uFF1B\u90AE\u7BB1\u672A\u9A8C\u8BC1";
      await client.query("INSERT INTO public.identity_management_audit(actor_id,target_id,action,product_id,reason) VALUES($1,$1,$2,$3,$4)", [userId, "identity.register", input.product, reason]);
      await client.query("INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision) VALUES($1,$2,$3,$4)", ["identity.register", userId, input.product, 1]);
      return success({ email: input.email });
    }));
  }
  credential(email3) {
    return this.execute(async () => {
      const rows = await this.pool.query(`SELECT u.user_id AS "userId",c.password_hash AS "passwordHash",u.active,u.security_revision AS "securityRevision",u.must_change_password AS "mustChangePassword"
        FROM public.identity_login_emails e JOIN public.identity_users u USING(user_id) JOIN public.identity_credentials c USING(user_id) WHERE e.email=$1`, [email3]);
      return success(rows.rows[0] ?? null);
    });
  }
  createSession(input) {
    return this.execute(() => this.tx(async (client) => {
      const user = await client.query("SELECT user_id FROM public.identity_users WHERE user_id=$1 AND active AND security_revision=$2 FOR SHARE", [input.userId, input.securityRevision]);
      if (!user.rows.length)
        return success(null);
      await client.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,$3,$4,$5)", [input.tokenHash, input.userId, input.securityRevision, input.expiresAt, input.client ?? "api"]);
      await client.query("INSERT INTO public.identity_audit(user_id,event) VALUES($1,'login')", [input.userId]);
      const result2 = await client.query(`SELECT ${IDENTITY_COLUMNS} FROM public.identity_users u JOIN public.identity_login_emails e USING(user_id) WHERE u.user_id=$1`, [input.userId]);
      return success(result2.rows[0]);
    }));
  }
  identity(tokenHash, client = "api") {
    return this.execute(async () => {
      const result2 = await this.pool.query(`SELECT ${IDENTITY_COLUMNS} FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) JOIN public.identity_login_emails e USING(user_id) WHERE ${SESSION_FILTER} AND s.client=$2`, [tokenHash, client]);
      return success(result2.rows[0] ?? null);
    });
  }
  accountProfile(tokenHash) {
    return this.execute(async () => {
      const result2 = await this.pool.query(`SELECT u.user_id AS "userId",u.display_name AS "displayName",
        COALESCE(p.avatar_id,'default') AS "avatarId",COALESCE(p.bio,'') AS bio,
        g.total_xp AS "totalXp",g.today_xp AS "todayXp",g.today_key::text AS "todayKey"
        FROM public.identity_sessions s JOIN public.identity_users u USING(user_id)
        LEFT JOIN public.identity_user_profiles p USING(user_id)
        LEFT JOIN public.identity_account_growth_projection g USING(user_id)
        WHERE ${SESSION_FILTER} AND s.client='api'`, [tokenHash]);
      return success(profileFromRow(result2.rows[0]));
    });
  }
  updateAccountProfile(tokenHash, patch) {
    return this.execute(() => this.tx(async (client) => {
      const allowed = await client.query(`SELECT u.user_id AS "userId",u.display_name AS "displayName",
        COALESCE(p.avatar_id,'default') AS "avatarId",COALESCE(p.bio,'') AS bio
        FROM public.identity_sessions s JOIN public.identity_users u USING(user_id)
        LEFT JOIN public.identity_user_profiles p USING(user_id)
        WHERE ${SESSION_FILTER} AND s.client='api' FOR UPDATE OF u`, [tokenHash]);
      if (!allowed.rows.length)
        return success(null);
      const userId = allowed.rows[0].userId, current = allowed.rows[0];
      const displayChanged = patch.displayName !== void 0 && patch.displayName !== current.displayName;
      const profileChanged = patch.avatarId !== void 0 && patch.avatarId !== current.avatarId || patch.bio !== void 0 && patch.bio !== current.bio;
      if (displayChanged)
        await client.query("UPDATE public.identity_users SET display_name=$2,management_revision=management_revision+1 WHERE user_id=$1", [userId, patch.displayName]);
      if (profileChanged) {
        await client.query(
          `INSERT INTO public.identity_user_profiles(user_id,avatar_id,bio) VALUES($1,COALESCE($2,'default'),COALESCE($3,''))
          ON CONFLICT(user_id) DO UPDATE SET avatar_id=COALESCE($2,public.identity_user_profiles.avatar_id),bio=COALESCE($3,public.identity_user_profiles.bio),updated_at=now()`,
          [userId, patch.avatarId ?? null, patch.bio ?? null]
        );
      }
      if (displayChanged || profileChanged)
        await client.query(`INSERT INTO public.identity_management_audit(actor_id,target_id,action,reason)
        VALUES($1,$1,'identity.profile.updated','\u672C\u4EBA\u66F4\u65B0\u5171\u4EAB\u8D26\u53F7\u8D44\u6599')`, [userId]);
      const result2 = await client.query(`SELECT u.user_id AS "userId",u.display_name AS "displayName",
        COALESCE(p.avatar_id,'default') AS "avatarId",COALESCE(p.bio,'') AS bio,
        g.total_xp AS "totalXp",g.today_xp AS "todayXp",g.today_key::text AS "todayKey"
        FROM public.identity_users u LEFT JOIN public.identity_user_profiles p USING(user_id)
        LEFT JOIN public.identity_account_growth_projection g USING(user_id) WHERE u.user_id=$1`, [userId]);
      return success(profileFromRow(result2.rows[0]));
    }));
  }
  recordGrowthEvent(tokenHash, event3) {
    return this.execute(() => this.tx(async (client) => {
      const allowed = await client.query(`SELECT u.user_id AS "userId" FROM public.identity_sessions s JOIN public.identity_users u USING(user_id)
        WHERE ${SESSION_FILTER} AND s.client='api' AND EXISTS(
          SELECT 1 FROM public.identity_product_access a WHERE a.user_id=u.user_id AND a.product_id=$2 AND a.active
        ) FOR UPDATE OF u`, [tokenHash, event3.sourceProduct]);
      if (!allowed.rows.length)
        return success(null);
      const userId = allowed.rows[0].userId, rule = growthEventRule(event3.sourceProduct, event3.eventType);
      if (!rule || event3.ruleVersion !== GROWTH_RULE_VERSION || event3.points > rule.points)
        return failure("INVALID_INPUT", "\u6210\u957F\u4E8B\u4EF6\u4E0D\u7B26\u5408\u4E2D\u5FC3\u89C4\u5219");
      const state = await client.query(`SELECT (($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)::text AS "occurredDay",
        ((now() AT TIME ZONE 'Asia/Shanghai')::date)::text AS "todayKey"`, [event3.occurredAt]);
      const projection2 = await client.query("SELECT total_xp,today_xp,today_key::text FROM public.identity_account_growth_projection WHERE user_id=$1 FOR UPDATE", [userId]);
      if (!projection2.rows.length) {
        const count = await client.query("SELECT count(*)::int AS n FROM public.identity_account_experience_events WHERE user_id=$1", [userId]);
        if (count.rows[0].n > 0)
          return failure("CONFLICT", "\u4E2D\u5FC3\u6210\u957F\u6295\u5F71\u7F3A\u5931\uFF0C\u8BF7\u5148\u5B8C\u6210\u5386\u53F2\u8FC1\u79FB");
        await client.query("INSERT INTO public.identity_account_growth_projection(user_id) VALUES($1) ON CONFLICT DO NOTHING", [userId]);
      }
      const current = (await client.query("SELECT total_xp,today_xp,today_key::text FROM public.identity_account_growth_projection WHERE user_id=$1 FOR UPDATE", [userId])).rows[0];
      const duplicate = await client.query(`SELECT 1 FROM public.identity_account_experience_events
        WHERE user_id=$1 AND source_product=$2 AND event_type=$3 AND subject_key=$4`, [userId, event3.sourceProduct, event3.eventType, event3.subjectKey]);
      if (duplicate.rows.length)
        return success(noGrowthAward(growthSummary(Number(current.total_xp), Number(current.today_xp), current.today_key)));
      const earned = (await client.query(`SELECT COALESCE(SUM(points),0)::int AS n FROM public.identity_account_experience_events
        WHERE user_id=$1 AND rule_version>=2 AND event_type<>'account_growth_reset'
          AND (occurred_at AT TIME ZONE 'Asia/Shanghai')::date=$2::date`, [userId, state.rows[0].occurredDay])).rows[0].n;
      const awarded = rule.dailyCap === null ? event3.points : Math.min(event3.points, Math.max(0, rule.dailyCap - Number(earned)));
      if (awarded <= 0)
        return success(noGrowthAward(growthSummary(Number(current.total_xp), Number(current.today_xp), current.today_key)));
      const inserted = await client.query(
        `INSERT INTO public.identity_account_experience_events
        (event_id,user_id,source_product,event_type,subject_key,points,rule_version,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING event_id`,
        [stableGrowthEventId(userId, event3.sourceProduct, event3.eventId), userId, event3.sourceProduct, event3.eventType, event3.subjectKey, awarded, event3.ruleVersion, event3.occurredAt]
      );
      if (!inserted.rows.length)
        return success(noGrowthAward(growthSummary(Number(current.total_xp), Number(current.today_xp), current.today_key)));
      const total = Math.max(0, Number(current.total_xp) + awarded);
      const summary = growthSummary(total, state.rows[0].occurredDay === state.rows[0].todayKey ? Number(earned) + awarded : Number(current.today_xp), state.rows[0].occurredDay === state.rows[0].todayKey ? state.rows[0].todayKey : current.today_key);
      await client.query(
        `UPDATE public.identity_account_growth_projection SET total_xp=$2,cycle=$3,level=$4,today_xp=$5,today_key=$6,updated_at=now() WHERE user_id=$1`,
        [userId, summary.totalXp, summary.cycle, summary.level, summary.todayXp, summary.todayKey]
      );
      const receipt = { awarded: true, awardedPoints: awarded, summary };
      return success(receipt);
    }));
  }
  navigatorAccess(tokenHash) {
    return this.execute(async () => {
      const result2 = await this.pool.query(`SELECT u.user_id AS "userId",e.email,u.display_name AS "displayName",
        CASE WHEN u.identity_admin THEN 'superadmin'
          WHEN a.active AND EXISTS(SELECT 1 FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='navigator' AND g.role='operations' AND g.active) THEN 'operator'
          WHEN a.active AND EXISTS(SELECT 1 FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='navigator' AND g.role='sales' AND g.active) THEN 'sales'
          ELSE NULL END AS role
        FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) JOIN public.identity_login_emails e USING(user_id)
        LEFT JOIN public.identity_product_access a ON a.user_id=u.user_id AND a.product_id='navigator'
        WHERE ${SESSION_FILTER} AND s.client IN ('api','browser') AND NOT u.must_change_password`, [tokenHash]);
      const row2 = result2.rows[0];
      return success(row2?.role ? row2 : null);
    });
  }
  revoke(tokenHash) {
    return this.execute(() => this.tx(async (client) => {
      const result2 = await client.query("UPDATE public.identity_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL RETURNING user_id", [tokenHash]);
      if (result2.rows.length)
        await client.query("INSERT INTO public.identity_audit(user_id,event) VALUES($1,'logout')", [result2.rows[0].user_id]);
      return success(void 0);
    }));
  }
  listUsers(tokenHash) {
    return this.execute(async () => {
      const rows = await this.pool.query(`WITH allowed AS (
        SELECT 1 FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) WHERE ${SESSION_FILTER} AND s.client='api' AND u.identity_admin AND NOT u.must_change_password
      ), items AS (
        SELECT ${IDENTITY_COLUMNS} FROM public.identity_users u JOIN public.identity_login_emails e USING(user_id)
        WHERE u.deleted_at IS NULL AND EXISTS(SELECT 1 FROM allowed) ORDER BY u.created_at,u.user_id LIMIT $2
      ) SELECT EXISTS(SELECT 1 FROM allowed) AS allowed,
        COALESCE((SELECT jsonb_agg(to_jsonb(items)) FROM items),'[]'::jsonb) AS items`, [tokenHash, AUTH_LIMITS.usersPage]);
      return rows.rows[0].allowed ? success(rows.rows[0].items) : failure("FORBIDDEN", "\u65E0\u8D26\u53F7\u7BA1\u7406\u6743\u9650");
    });
  }
  ready() {
    return this.execute(async () => {
      await this.pool.query("SELECT 1 FROM public.identity_users LIMIT 1");
      return success(void 0);
    });
  }
  createDesktopSession(input) {
    return this.execute(() => this.tx(async (client) => {
      const user = await client.query("SELECT user_id FROM public.identity_users WHERE user_id=$1 AND active AND security_revision=$2 FOR SHARE", [input.userId, input.securityRevision]);
      if (!user.rows.length)
        return success(null);
      const session = await client.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,$3,$4,'api') RETURNING session_id", [input.tokenHash, input.userId, input.securityRevision, input.expiresAt]);
      await client.query("INSERT INTO public.identity_desktop_refresh_tokens(token_hash,session_id,idle_expires_at,absolute_expires_at) VALUES($1,$2,$3,$4)", [input.refreshHash, session.rows[0].session_id, input.idleExpiresAt, input.absoluteExpiresAt]);
      await client.query("INSERT INTO public.identity_audit(user_id,event) VALUES($1,'login')", [input.userId]);
      const identity = await client.query(`SELECT ${IDENTITY_COLUMNS} FROM public.identity_users u JOIN public.identity_login_emails e USING(user_id) WHERE u.user_id=$1`, [input.userId]);
      return success(identity.rows[0]);
    }));
  }
  rotateDesktopSession(refreshHash, input) {
    return this.execute(() => this.tx(async (client) => {
      const session = await client.query(`SELECT s.session_id,s.user_id,r.absolute_expires_at FROM public.identity_desktop_refresh_tokens r
        JOIN public.identity_sessions s USING(session_id) JOIN public.identity_users u USING(user_id)
        WHERE r.token_hash=$1 AND r.consumed_at IS NULL AND r.idle_expires_at>now() AND r.absolute_expires_at>now()
        AND s.revoked_at IS NULL AND u.active AND s.security_revision=u.security_revision FOR UPDATE OF s,r FOR SHARE OF u`, [refreshHash]);
      if (!session.rows.length)
        return success(null);
      const row2 = session.rows[0];
      const consumed = await client.query("UPDATE public.identity_desktop_refresh_tokens SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL RETURNING token_hash", [refreshHash]);
      if (!consumed.rows.length)
        return success(null);
      const updated = await client.query("UPDATE public.identity_sessions SET token_hash=$2,expires_at=LEAST($3::timestamptz,$4::timestamptz) WHERE session_id=$1 RETURNING expires_at", [row2.session_id, input.tokenHash, input.expiresAt, row2.absolute_expires_at]);
      await client.query("INSERT INTO public.identity_desktop_refresh_tokens(token_hash,session_id,idle_expires_at,absolute_expires_at) VALUES($1,$2,LEAST($3::timestamptz,$4::timestamptz),$4)", [input.refreshHash, row2.session_id, input.idleExpiresAt, row2.absolute_expires_at]);
      const identity = await client.query(`SELECT ${IDENTITY_COLUMNS} FROM public.identity_users u JOIN public.identity_login_emails e USING(user_id) WHERE u.user_id=$1`, [row2.user_id]);
      return success({ identity: identity.rows[0], expiresAt: updated.rows[0].expires_at.toISOString(), absoluteExpiresAt: row2.absolute_expires_at.toISOString() });
    }));
  }
  desktopIdentity(tokenHash) {
    return this.execute(async () => {
      const result2 = await this.pool.query(`SELECT ${IDENTITY_COLUMNS} FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) JOIN public.identity_login_emails e USING(user_id)
        WHERE ${SESSION_FILTER} AND s.client='api' AND EXISTS(SELECT 1 FROM public.identity_desktop_refresh_tokens r WHERE r.session_id=s.session_id AND r.consumed_at IS NULL AND r.idle_expires_at>now() AND r.absolute_expires_at>now())`, [tokenHash]);
      return success(result2.rows[0] ?? null);
    });
  }
  revokeDesktopSession(refreshHash) {
    return this.execute(() => this.tx(async (client) => {
      const revoked = await client.query(`UPDATE public.identity_sessions s SET revoked_at=now() FROM public.identity_desktop_refresh_tokens r WHERE r.token_hash=$1 AND r.session_id=s.session_id AND s.revoked_at IS NULL RETURNING s.user_id`, [refreshHash]);
      if (revoked.rows.length)
        await client.query("INSERT INTO public.identity_audit(user_id,event) VALUES($1,'logout')", [revoked.rows[0].user_id]);
      return success(void 0);
    }));
  }
  changePassword(hash, expectedHash, revision, newHash, clientType = "browser") {
    return this.execute(() => this.tx(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK]);
      const actor = await client.query(`SELECT u.user_id FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) JOIN public.identity_credentials c USING(user_id)
        WHERE s.token_hash=$1 AND s.client=$4 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND u.security_revision=s.security_revision
        AND u.security_revision=$2 AND c.password_hash=$3 FOR UPDATE OF u,c`, [hash, revision, expectedHash, clientType]);
      if (!actor.rows.length)
        return failure("UNAUTHORIZED", "\u4F1A\u8BDD\u6216\u5BC6\u7801\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55");
      const id = actor.rows[0].user_id;
      await client.query("UPDATE public.identity_credentials SET password_hash=$2,changed_at=now() WHERE user_id=$1", [id, newHash]);
      await client.query("UPDATE public.identity_users SET must_change_password=false,security_revision=security_revision+1,management_revision=management_revision+1 WHERE user_id=$1", [id]);
      await client.query("UPDATE public.identity_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [id]);
      await client.query("UPDATE public.identity_management_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL", [id]);
      await client.query("INSERT INTO public.identity_management_audit(actor_id,target_id,action,reason) VALUES($1,$1,'identity.password.changed','\u7528\u6237\u4E3B\u52A8\u8BBE\u7F6E\u65B0\u5BC6\u7801\uFF0C\u5168\u90E8\u65E7\u4F1A\u8BDD\u5DF2\u64A4\u9500')", [id]);
      await client.query("INSERT INTO public.identity_outbox(event_type,user_id,revision) SELECT 'identity.password.changed',user_id,management_revision FROM public.identity_users WHERE user_id=$1", [id]);
      return success(void 0);
    }));
  }
};

// server/adapters/password.ts
var import_node_crypto4 = require("node:crypto");
var PASSWORD_PARAMETERS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
var SALT_BYTES = 16;
var HASH_BYTES = 32;
var TOKEN_BYTES = 32;
var HASH_PREFIX = "scrypt-v1$131072$8$1";
var HASH_PATTERN = /^scrypt-v1\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
var LEGACY_HASH_PATTERN = /^pbkdf2_sha256\$(\d+)\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
var LEGACY_HASH_BYTES = 32;
var LEGACY_HASH_DIGEST = "sha256";
var LEGACY_MIN_ITERATIONS = 1e5;
var LEGACY_MAX_ITERATIONS = 1e6;
var PasswordAdapter = class {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
  }
  active = 0;
  dummyHash = "";
  async initialize() {
    this.dummyHash = await this.hash((0, import_node_crypto4.randomBytes)(TOKEN_BYTES).toString("hex"));
  }
  async derive(password, salt) {
    if (this.active >= this.maxConcurrent)
      throw new Error("\u5BC6\u7801\u6821\u9A8C\u5E76\u53D1\u5DF2\u6EE1");
    this.active++;
    try {
      return await new Promise((resolve3, reject) => (0, import_node_crypto4.scrypt)(password, salt, HASH_BYTES, PASSWORD_PARAMETERS, (error, key) => error ? reject(error) : resolve3(key)));
    } finally {
      this.active--;
    }
  }
  async deriveLegacy(password, salt, iterations) {
    if (this.active >= this.maxConcurrent)
      throw new Error("\u5BC6\u7801\u6821\u9A8C\u5E76\u53D1\u5DF2\u6EE1");
    this.active++;
    try {
      return await new Promise((resolve3, reject) => (0, import_node_crypto4.pbkdf2)(
        password,
        salt,
        iterations,
        LEGACY_HASH_BYTES,
        LEGACY_HASH_DIGEST,
        (error, key) => error ? reject(error) : resolve3(key)
      ));
    } finally {
      this.active--;
    }
  }
  async hash(password) {
    const salt = (0, import_node_crypto4.randomBytes)(SALT_BYTES), key = await this.derive(password, salt);
    return `${HASH_PREFIX}$${salt.toString("hex")}$${key.toString("hex")}`;
  }
  async verify(password, hash) {
    const match = HASH_PATTERN.exec(hash);
    if (match) {
      const actual = await this.derive(password, Buffer.from(match[1], "hex"));
      return (0, import_node_crypto4.timingSafeEqual)(actual, Buffer.from(match[2], "hex"));
    }
    const legacy = LEGACY_HASH_PATTERN.exec(hash);
    if (legacy) {
      const iterations = Number(legacy[1]);
      if (!Number.isSafeInteger(iterations) || iterations < LEGACY_MIN_ITERATIONS || iterations > LEGACY_MAX_ITERATIONS)
        return false;
      const actual = await this.deriveLegacy(password, legacy[2], iterations);
      return (0, import_node_crypto4.timingSafeEqual)(actual, Buffer.from(legacy[3], "hex"));
    }
    if (!HASH_PATTERN.exec(this.dummyHash))
      throw new Error("\u5BC6\u7801\u6821\u9A8C\u5668\u672A\u521D\u59CB\u5316");
    await this.derive(password, Buffer.alloc(SALT_BYTES));
    return false;
  }
};
var tokenAdapter = {
  create: () => (0, import_node_crypto4.randomBytes)(TOKEN_BYTES).toString("base64url"),
  hash: (token) => (0, import_node_crypto4.createHash)("sha256").update(token).digest("hex")
};

// server/adapters/login-rate.ts
var MILLISECONDS_PER_SECOND4 = 1e3;
var LoginRateGate = class {
  constructor(config, clock) {
    this.config = config;
    this.clock = clock;
  }
  buckets = /* @__PURE__ */ new Map();
  consume(key, maximum) {
    const now = this.clock.now();
    for (const [id, bucket2] of this.buckets)
      if (bucket2.expires <= now)
        this.buckets.delete(id);
    const bucket = this.buckets.get(key);
    if (bucket) {
      if (bucket.count >= maximum)
        return false;
      bucket.count++;
      return true;
    }
    if (this.buckets.size >= this.config.rate_bucket_max)
      return false;
    this.buckets.set(key, { count: 1, expires: now + this.config.login_window_seconds * MILLISECONDS_PER_SECOND4 });
    return true;
  }
  allow(key, address) {
    if (address && !this.consume(`ip:${address}`, this.config.login_ip_max_attempts))
      return false;
    return this.consume(`account:${key}`, this.config.login_max_attempts);
  }
};

// server/adapters/online-config.ts
var import_node_fs2 = require("node:fs");
var import_node_path3 = __toESM(require("node:path"));
var ONLINE_CONFIG_PATH = ".work/pg-crm/online.json";
var PORT_MAX = 65535;
var SESSION_TTL_MAX_SECONDS = 86400;
var DEFAULT_PRODUCTION_HTTP_PORT = 55847;
var PRODUCTION_RUNTIME_DIRECTORY = "MiloginCenter";
var DEFAULT_BIND_HOST = "127.0.0.1";
var CONTAINER_BIND_HOST = "0.0.0.0";
var ALLOWED_BIND_HOSTS = /* @__PURE__ */ new Set([DEFAULT_BIND_HOST, CONTAINER_BIND_HOST]);
function productionBindHost(env) {
  const host = (env.PROSPECTOR_CENTER_BIND_HOST || DEFAULT_BIND_HOST).trim();
  if (!ALLOWED_BIND_HOSTS.has(host))
    throw new Error("\u6B63\u5F0F\u4E2D\u5FC3\u76D1\u542C\u5730\u5740\u4EC5\u5141\u8BB8\u56DE\u73AF\u6216\u5BB9\u5668\u5185\u7F51");
  return host;
}
function productionPort(env) {
  const port = Number(env.APP_PORT || DEFAULT_PRODUCTION_HTTP_PORT);
  if (!Number.isSafeInteger(port) || port < 1 || port > PORT_MAX)
    throw new Error("\u6B63\u5F0F\u4E2D\u5FC3\u670D\u52A1\u7AEF\u53E3\u65E0\u6548");
  return port;
}
function onlineRuntimeDirectory(env = process.env) {
  const configured = env.PROSPECTOR_CENTER_RUNTIME_DIR?.trim();
  if (configured) {
    if (!import_node_path3.default.isAbsolute(configured))
      throw new Error("\u6B63\u5F0F\u4E2D\u5FC3\u8FD0\u884C\u76EE\u5F55\u5FC5\u987B\u662F\u7EDD\u5BF9\u8DEF\u5F84");
    return import_node_path3.default.resolve(configured);
  }
  if (env.PROSPECTOR_CENTER_MODE === "production") {
    return import_node_path3.default.join(env.ProgramData || "C:\\ProgramData", PRODUCTION_RUNTIME_DIRECTORY);
  }
  if (env.PROSPECTOR_CENTER_MODE && env.PROSPECTOR_CENTER_MODE !== "test")
    throw new Error("\u672A\u77E5\u4E2D\u5FC3\u8FD0\u884C\u6A21\u5F0F");
  return import_node_path3.default.dirname(ONLINE_CONFIG_PATH);
}
function readOnlineConfig(env = process.env) {
  if (env.PROSPECTOR_CENTER_MODE === "production") {
    const origin = env.PROSPECTOR_CENTER_PUBLIC_ORIGIN;
    if (!origin)
      throw new Error("\u6B63\u5F0F\u4E2D\u5FC3\u7F3A\u5C11\u516C\u5F00\u8BBF\u95EE\u5730\u5740");
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("\u6B63\u5F0F\u4E2D\u5FC3\u516C\u5F00\u8BBF\u95EE\u5730\u5740\u65E0\u6548");
    }
    const localHttp = env.PROSPECTOR_CENTER_LOCAL_HTTP === "1" && origin === "http://127.0.0.1:55847";
    if (parsed.protocol !== "https:" && !localHttp || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error("\u6B63\u5F0F\u4E2D\u5FC3\u53EA\u63A5\u53D7 HTTPS\uFF0C\u6216\u663E\u5F0F\u5F00\u542F\u7684\u672C\u673A\u56DE\u73AF HTTP");
    }
    const navigatorUrl = env.PROSPECTOR_NAVIGATOR_URL || ONLINE_DEFAULTS.navigator_url;
    const navigatorEntryUrl = env.PROSPECTOR_NAVIGATOR_ENTRY_URL || navigatorUrl;
    for (const candidate of [navigatorUrl, navigatorEntryUrl]) {
      try {
        const parsedNavigator = new URL(candidate);
        if (!["http:", "https:"].includes(parsedNavigator.protocol) || parsedNavigator.username || parsedNavigator.password)
          throw new Error();
      } catch {
        throw new Error("Navigator \u670D\u52A1\u5730\u5740\u65E0\u6548");
      }
    }
    return {
      ...ONLINE_DEFAULTS,
      host: productionBindHost(env),
      port: productionPort(env),
      navigator_url: navigatorUrl,
      navigator_entry_url: navigatorEntryUrl,
      test_mode: false,
      public_origin: origin,
      ...localHttp ? { local_http: true } : {}
    };
  }
  if (env.PROSPECTOR_CENTER_MODE && env.PROSPECTOR_CENTER_MODE !== "test")
    throw new Error("\u672A\u77E5\u4E2D\u5FC3\u8FD0\u884C\u6A21\u5F0F");
  const input = JSON.parse((0, import_node_fs2.readFileSync)(ONLINE_CONFIG_PATH, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !(key in ONLINE_DEFAULTS)) || input.host !== ONLINE_DEFAULTS.host || input.port !== ONLINE_DEFAULTS.port || typeof input.test_mode !== "boolean" || typeof input.navigator_url !== "string" || typeof input.navigator_entry_url !== "string")
    throw new Error("\u672C\u8282\u70B9\u4EC5\u652F\u6301\u56FA\u5B9A\u56DE\u73AF\u6D4B\u8BD5\u670D\u52A1\u914D\u7F6E");
  for (const candidate of [input.navigator_url, input.navigator_entry_url]) {
    try {
      const parsedNavigator = new URL(candidate);
      if (!["http:", "https:"].includes(parsedNavigator.protocol) || parsedNavigator.username || parsedNavigator.password)
        throw new Error();
    } catch {
      throw new Error("Navigator \u670D\u52A1\u5730\u5740\u65E0\u6548");
    }
  }
  for (const [key, value2] of Object.entries(ONLINE_DEFAULTS)) {
    if (typeof value2 === "number" && (!Number.isSafeInteger(input[key]) || input[key] < 1))
      throw new Error("\u5728\u7EBF\u914D\u7F6E\u9608\u503C\u65E0\u6548");
  }
  if (input.port > PORT_MAX || input.session_ttl_seconds > SESSION_TTL_MAX_SECONDS || input.password_concurrency > ONLINE_DEFAULTS.password_concurrency || input.request_body_bytes > ONLINE_DEFAULTS.request_body_bytes)
    throw new Error("\u6D4B\u8BD5\u670D\u52A1\u8D44\u6E90\u9608\u503C\u8D85\u9650");
  return input;
}

// server/adapters/fixtures.ts
var import_node_fs3 = require("node:fs");
var import_node_crypto5 = require("node:crypto");
var FIXTURE_PATH = ".work/pg-crm/online-fixtures.json";
var PRIVATE_FILE_MODE = 384;
var PASSWORD_BYTES = 24;
var JSON_INDENT = 2;
var FIXTURE_MARKER = "prospector-online-fixtures-v1";
var FIXTURES = [
  { email: "agent-admin@example.invalid", displayName: "Agent \u6D4B\u8BD5\u7BA1\u7406\u5458", identityAdmin: false, crmRoles: ["operations"] },
  { email: "agent-user@example.invalid", displayName: "Agent \u6D4B\u8BD5\u7528\u6237", identityAdmin: false, crmRoles: ["sales"] }
];
async function initializeFixtures(repo, passwords, testMode) {
  if (!testMode)
    return;
  if (!(0, import_node_fs3.existsSync)(FIXTURE_PATH)) {
    const accounts = FIXTURES.map((item) => ({ email: item.email, userId: (0, import_node_crypto5.randomUUID)(), password: (0, import_node_crypto5.randomBytes)(PASSWORD_BYTES).toString("base64url") }));
    (0, import_node_fs3.writeFileSync)(FIXTURE_PATH, JSON.stringify({ marker: FIXTURE_MARKER, accounts }, null, JSON_INDENT), { mode: PRIVATE_FILE_MODE, flag: "wx" });
  }
  const file = JSON.parse((0, import_node_fs3.readFileSync)(FIXTURE_PATH, "utf8"));
  if (file.marker !== FIXTURE_MARKER || !Array.isArray(file.accounts) || file.accounts.length !== FIXTURES.length)
    throw new Error("\u6D4B\u8BD5\u8D26\u6237\u6587\u4EF6\u4E0D\u5339\u914D\uFF0C\u4FDD\u7559\u73B0\u72B6");
  for (const definition of FIXTURES) {
    const accounts = file.accounts.filter((item) => item.email === definition.email), account = accounts[0];
    if (accounts.length !== 1 || !account || typeof account.userId !== "string" || !/^[a-f0-9-]{36}$/.test(account.userId) || typeof account.password !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(account.password))
      throw new Error("\u6D4B\u8BD5\u8D26\u6237\u914D\u7F6E\u65E0\u6548");
    const result2 = await repo.ensureFixture({ ...definition, userId: account.userId, passwordHash: await passwords.hash(account.password) });
    if (!result2.ok)
      throw new Error("\u6D4B\u8BD5\u8D26\u6237\u521D\u59CB\u5316\u88AB\u62D2\u7EDD\uFF0C\u4FDD\u7559\u73B0\u6709\u8EAB\u4EFD");
  }
}

// server/adapters/logger.ts
var serverLog = {
  write(level, context, message) {
    process.stdout.write(`[${(/* @__PURE__ */ new Date()).toISOString()}] [${level}] [${context}] ${message}
`);
  }
};

// server/core/account-profile.ts
var ACCOUNT_PROFILE_LIMITS = {
  aliasMax: 128,
  avatarIdMax: 64,
  bioMax: 500
};
var AVATAR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
function normalizeAccountProfilePatch(value2) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
    throw new Error("\u8D26\u53F7\u8D44\u6599\u53C2\u6570\u65E0\u6548");
  const input = value2;
  if (Object.keys(input).some((key) => !["displayName", "avatarId", "bio"].includes(key)))
    throw new Error("\u8D26\u53F7\u8D44\u6599\u5305\u542B\u672A\u77E5\u5B57\u6BB5");
  const patch = {};
  if (input.displayName !== void 0) {
    if (typeof input.displayName !== "string")
      throw new Error("\u7528\u6237\u540D\u987B\u4E3A\u6587\u5B57");
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > 64 || [...displayName].some((char) => char.charCodeAt(0) < 32))
      throw new Error("\u7528\u6237\u540D\u987B\u4E3A1\u81F364\u4E2A\u5B57\u7B26");
    patch.displayName = displayName;
  }
  if (input.avatarId !== void 0) {
    if (typeof input.avatarId !== "string" || !AVATAR_ID_PATTERN.test(input.avatarId))
      throw new Error("\u5934\u50CF ID \u65E0\u6548");
    patch.avatarId = input.avatarId;
  }
  if (input.bio !== void 0) {
    if (typeof input.bio !== "string" || input.bio.length > ACCOUNT_PROFILE_LIMITS.bioMax)
      throw new Error("\u4E2A\u4EBA\u7B80\u4ECB\u8FC7\u957F");
    patch.bio = input.bio.trim();
  }
  if (!Object.keys(patch).length)
    throw new Error("\u6CA1\u6709\u9700\u8981\u4FDD\u5B58\u7684\u8D26\u53F7\u8D44\u6599");
  return patch;
}

// server/services/auth.ts
var MILLISECONDS_PER_SECOND5 = 1e3;
var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
function createAuthService(repo, passwords, tokens, clock, ttlSeconds) {
  const unauthorized2 = () => failure("UNAUTHORIZED", "\u767B\u5F55\u4FE1\u606F\u65E0\u6548\u6216\u4F1A\u8BDD\u5DF2\u5931\u6548");
  async function me(token, client = "api") {
    if (token.length !== AUTH_LIMITS.tokenCharacters || !TOKEN_PATTERN.test(token))
      return unauthorized2();
    const result2 = await repo.identity(tokens.hash(token), client);
    if (!result2.ok)
      return result2;
    if (result2.data?.mustChangePassword && client === "api")
      return failure("PASSWORD_CHANGE_REQUIRED", "\u8BF7\u5148\u5728\u7BA1\u7406\u9875\u9762\u4FEE\u6539\u521D\u59CB\u5BC6\u7801");
    return result2.data ? success(result2.data) : unauthorized2();
  }
  return {
    ready: () => repo.ready(),
    async login(input, client = "api") {
      if (!input || typeof input !== "object" || Array.isArray(input))
        return failure("INVALID_INPUT", "\u767B\u5F55\u53C2\u6570\u65E0\u6548");
      const value2 = input;
      if (Object.keys(value2).some((key) => key !== "email" && key !== "password") || typeof value2.email !== "string" || typeof value2.password !== "string" || value2.email.length > AUTH_LIMITS.emailMax || value2.email !== value2.email.trim() || !EMAIL_PATTERN.test(value2.email.trim()) || value2.password.length < BOOTSTRAP_LOGIN_MIN || value2.password.length > AUTH_LIMITS.passwordMax)
        return failure("INVALID_INPUT", "\u767B\u5F55\u53C2\u6570\u65E0\u6548");
      const credential = await repo.credential(value2.email.trim().toLowerCase());
      if (!credential.ok)
        return credential;
      if (value2.password.length < AUTH_LIMITS.passwordMin && !credential.data?.mustChangePassword)
        return unauthorized2();
      let verified;
      try {
        verified = await passwords.verify(value2.password, credential.data?.passwordHash ?? "");
      } catch {
        return failure("UNAVAILABLE", "\u767B\u5F55\u6821\u9A8C\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      }
      if (!verified || !credential.data?.active)
        return unauthorized2();
      if (credential.data.mustChangePassword && client === "api")
        return failure("PASSWORD_CHANGE_REQUIRED", "\u8BF7\u5148\u5728\u7BA1\u7406\u9875\u9762\u4FEE\u6539\u521D\u59CB\u5BC6\u7801");
      const token = tokens.create(), expiresAt = new Date(clock.now() + ttlSeconds * MILLISECONDS_PER_SECOND5).toISOString();
      const session = await repo.createSession({ tokenHash: tokens.hash(token), userId: credential.data.userId, securityRevision: credential.data.securityRevision, expiresAt, client });
      if (!session.ok)
        return session;
      return session.data ? success({ token, expiresAt, identity: session.data }) : unauthorized2();
    },
    me,
    async accountProfile(token) {
      const identity = await me(token);
      if (!identity.ok)
        return identity;
      if (!repo.accountProfile)
        return failure("UNAVAILABLE", "\u8D26\u53F7\u8D44\u6599\u6682\u4E0D\u53EF\u7528");
      const result2 = await repo.accountProfile(tokens.hash(token));
      if (!result2.ok)
        return result2;
      return result2.data?.userId === identity.data.userId ? success(result2.data) : unauthorized2();
    },
    async updateAccountProfile(token, input) {
      const identity = await me(token);
      if (!identity.ok)
        return identity;
      if (!repo.updateAccountProfile)
        return failure("UNAVAILABLE", "\u8D26\u53F7\u8D44\u6599\u5199\u5165\u6682\u4E0D\u53EF\u7528");
      let patch;
      try {
        patch = normalizeAccountProfilePatch(input);
      } catch (error) {
        return failure("INVALID_INPUT", error instanceof Error ? error.message : "\u8D26\u53F7\u8D44\u6599\u53C2\u6570\u65E0\u6548");
      }
      const result2 = await repo.updateAccountProfile(tokens.hash(token), patch);
      if (!result2.ok)
        return result2;
      return result2.data?.userId === identity.data.userId ? success(result2.data) : unauthorized2();
    },
    async accountGrowth(token, input) {
      const identity = await me(token);
      if (!identity.ok)
        return identity;
      if (!repo.recordGrowthEvent)
        return failure("UNAVAILABLE", "\u6210\u957F\u8BB0\u8D26\u6682\u4E0D\u53EF\u7528");
      if (!isGrowthEventInput(input))
        return failure("INVALID_INPUT", "\u6210\u957F\u4E8B\u4EF6\u53C2\u6570\u65E0\u6548");
      return repo.recordGrowthEvent(tokens.hash(token), input);
    },
    async changeAccountPassword(token, input) {
      const identity = await me(token);
      if (!identity.ok)
        return identity;
      if (!repo.changePassword || typeof passwords.hash !== "function")
        return failure("UNAVAILABLE", "\u6539\u5BC6\u6682\u4E0D\u53EF\u7528");
      if (!input || typeof input !== "object" || Array.isArray(input))
        return failure("INVALID_INPUT", "\u6539\u5BC6\u8BF7\u6C42\u65E0\u6548");
      const value2 = input;
      if (Object.keys(value2).some((key) => key !== "currentPassword" && key !== "newPassword") || typeof value2.currentPassword !== "string" || !value2.currentPassword.length || value2.currentPassword.length > AUTH_LIMITS.passwordMax || !isNewAccountPassword(value2.newPassword) || value2.newPassword === value2.currentPassword)
        return failure("INVALID_INPUT", "\u65B0\u5BC6\u7801\u81F3\u5C116\u4F4D\uFF0C\u4EC5\u5141\u8BB8\u82F1\u6587\u5B57\u6BCD\u548C\u6570\u5B57\uFF0C\u4E14\u5FC5\u987B\u4E0E\u5F53\u524D\u5BC6\u7801\u4E0D\u540C");
      const credential = await repo.credential(identity.data.email);
      if (!credential.ok)
        return credential;
      if (!credential.data?.active)
        return unauthorized2();
      try {
        if (!await passwords.verify(value2.currentPassword, credential.data.passwordHash))
          return failure("UNAUTHORIZED", "\u5F53\u524D\u5BC6\u7801\u4E0D\u6B63\u786E");
        return await repo.changePassword(tokens.hash(token), credential.data.passwordHash, credential.data.securityRevision, await passwords.hash(value2.newPassword), "api");
      } catch {
        return failure("UNAVAILABLE", "\u6539\u5BC6\u6682\u4E0D\u53EF\u7528");
      }
    },
    async logout(token, client = "api") {
      const identity = await me(token, client);
      return identity.ok ? repo.revoke(tokens.hash(token)) : identity;
    },
    async users(token) {
      const identity = await me(token);
      if (!identity.ok)
        return identity;
      if (identity.data.mustChangePassword)
        return failure("PASSWORD_CHANGE_REQUIRED", "\u8BF7\u5148\u4FEE\u6539\u521D\u59CB\u5BC6\u7801");
      return identity.data.identityAdmin ? repo.listUsers(tokens.hash(token)) : failure("FORBIDDEN", "\u65E0\u8D26\u53F7\u7BA1\u7406\u6743\u9650");
    },
    async crmAccess(token) {
      const identity = await me(token);
      if (!identity.ok)
        return identity;
      if (identity.data.mustChangePassword)
        return failure("PASSWORD_CHANGE_REQUIRED", "\u8BF7\u5148\u4FEE\u6539\u521D\u59CB\u5BC6\u7801");
      if (!identity.data.crmRoles.length)
        return failure("FORBIDDEN", "\u65E0 CRM \u4EA7\u54C1\u51C6\u5165");
      const alias = { "crm:manage": "access.manage", "leads:import": "leads.import", "leads:publish": "leads.publish", "leads:review": "followups.read", "leads:claim": "leads.claim", "leads:develop": "leads.develop", "crm:audit": "audit.read" };
      return success({ capabilities: [...new Set(identity.data.crmRoles.flatMap((role) => [...CRM_CAPABILITIES[role]]))].filter((cap) => identity.data.crmCapabilities == null || identity.data.crmCapabilities.includes(alias[cap])) });
    },
    async navigatorAccess(token) {
      if (!repo.navigatorAccess)
        return failure("UNAVAILABLE", "Navigator \u6388\u6743\u6682\u4E0D\u53EF\u7528");
      const access2 = await repo.navigatorAccess(tokens.hash(token));
      if (!access2.ok)
        return access2;
      return access2.data ? success(access2.data) : failure("FORBIDDEN", "\u65E0 Navigator \u4EA7\u54C1\u51C6\u5165");
    }
  };
}

// server/services/admin.ts
var UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
var MILLISECONDS = 1e3;
function object(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function string(v, max) {
  return typeof v === "string" && !!v.trim() && v.length <= max;
}
function validCommand(v) {
  if (!object(v))
    return false;
  const allowed = {
    "user.create": ["action", "email", "role", "reason"],
    "user.restore": ["action", "userId", "revision", "reason"],
    "user.update": ["action", "userId", "revision", "active", "identityAdmin", "reason"],
    "navigator.update": ["action", "userId", "revision", "active", "role", "reason"],
    "user.delete": ["action", "userId", "revision", "reason"],
    "user.reset-password": ["action", "userId", "revision", "reason"],
    "product.update": ["action", "userId", "revision", "productId", "active", "roles", "capabilities", "scope", "reason", "role"],
    "session.revoke": ["action", "userId", "sessionId", "reason"],
    "challenge.issue": ["action", "purpose", "email", "displayName", "reason"]
  };
  if (typeof v.action !== "string" || !allowed[v.action] || Object.keys(v).some((k) => !allowed[v.action].includes(k)))
    return false;
  if (v.action !== "user.delete" && !string(v.reason, ADMIN_LIMITS.reasonMax))
    return false;
  if (v.action === "user.delete" && v.reason !== void 0 && v.reason !== "" && !string(v.reason, ADMIN_LIMITS.reasonMax))
    return false;
  if (v.action === "user.create")
    return isAccountEmail(v.email) && CRM_ROLES.includes(v.role);
  if (v.action === "challenge.issue")
    return (v.purpose === "activate" || v.purpose === "recover") && isAccountEmail(v.email) && string(v.displayName, ADMIN_LIMITS.displayNameMax);
  if (typeof v.userId !== "string" || !UUID4.test(v.userId))
    return false;
  if (v.action === "session.revoke")
    return typeof v.sessionId === "string" && UUID4.test(v.sessionId);
  if (!Number.isSafeInteger(v.revision) || v.revision < 1)
    return false;
  if (v.action === "user.delete" || v.action === "user.reset-password" || v.action === "user.restore")
    return true;
  if (typeof v.active !== "boolean")
    return false;
  if (v.action === "user.update")
    return typeof v.identityAdmin === "boolean";
  if (v.action === "navigator.update")
    return v.role === "operations" || v.role === "sales";
  if (v.role !== void 0 && !CRM_ROLES.includes(v.role))
    return false;
  if (v.productId !== "crm" || !Array.isArray(v.roles) || v.roles.some((role) => !CRM_ROLES.includes(role)) || new Set(v.roles).size !== v.roles.length || !Array.isArray(v.capabilities) || v.capabilities.some((cap) => typeof cap !== "string" || !capabilitiesFor(v.role !== void 0 ? [...CRM_ROLES] : v.roles).includes(cap)) || new Set(v.capabilities).size !== v.capabilities.length || !SCOPES.includes(v.scope))
    return false;
  const scopes = v.roles.includes("admin") || v.roles.includes("auditor") ? SCOPES : v.roles.includes("operations") ? ["own", "shared"] : ["own"];
  return v.role !== void 0 || scopes.includes(v.scope);
}
function createAdminService(repo, authRepo, passwords, tokens, clock, auth) {
  async function authenticated(token) {
    const result2 = await auth.me(token, "browser");
    return result2.ok && result2.data.mustChangePassword ? failure("PASSWORD_CHANGE_REQUIRED", "\u8BF7\u5148\u4FEE\u6539\u521D\u59CB\u5BC6\u7801") : result2;
  }
  return {
    async users(token, input) {
      if (!object(input) || typeof input.search !== "string" || input.search.length > ADMIN_LIMITS.searchMax || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > ADMIN_LIMITS.pageMax || !Number.isSafeInteger(input.offset) || input.offset < 0 || input.productId !== void 0 && input.productId !== "crm" && input.productId !== "navigator" || input.state !== void 0 && input.state !== "active" && input.state !== "archived")
        return failure("INVALID_INPUT", "\u7528\u6237\u67E5\u8BE2\u65E0\u6548");
      const actor = await authenticated(token);
      return actor.ok ? repo.users(tokens.hash(token), input) : actor;
    },
    async products(token) {
      const actor = await authenticated(token);
      return actor.ok ? repo.products(tokens.hash(token)) : actor;
    },
    async sessions(token, userId) {
      if (!UUID4.test(userId))
        return failure("INVALID_INPUT", "\u7528\u6237\u6807\u8BC6\u65E0\u6548");
      const actor = await authenticated(token);
      return actor.ok ? repo.sessions(tokens.hash(token), userId) : actor;
    },
    async audit(token, productId, userId) {
      if (productId !== void 0 && productId !== "crm" && productId !== "navigator")
        return failure("INVALID_INPUT", "\u4EA7\u54C1\u65E0\u6548");
      if (userId !== void 0 && !UUID4.test(userId))
        return failure("INVALID_INPUT", "\u7528\u6237\u6807\u8BC6\u65E0\u6548");
      const actor = await authenticated(token);
      return actor.ok ? repo.audit(tokens.hash(token), productId, userId) : actor;
    },
    async mutate(token, input, password) {
      if (!validCommand(input))
        return failure("INVALID_INPUT", "\u7BA1\u7406\u8BF7\u6C42\u65E0\u6548");
      const actor = await authenticated(token);
      if (!actor.ok)
        return actor;
      if (input.action === "user.create") {
        if (!actor.data.identityAdmin)
          return failure("FORBIDDEN", "\u65E0\u521B\u5EFA\u7528\u6237\u6743\u9650");
        if (!isNewAccountPassword(password))
          return failure("INVALID_INPUT", "\u521D\u59CB\u5BC6\u7801\u81F3\u5C116\u4F4D\uFF0C\u4EC5\u5141\u8BB8\u82F1\u6587\u5B57\u6BCD\u548C\u6570\u5B57");
        try {
          const result3 = await repo.mutate(tokens.hash(token), { ...input, email: input.email.trim().toLowerCase() }, void 0, await passwords.hash(password));
          return result3.ok ? success({}) : result3;
        } catch {
          return failure("UNAVAILABLE", "\u521B\u5EFA\u7528\u6237\u6682\u4E0D\u53EF\u7528");
        }
      }
      if (input.action === "user.restore") {
        if (!actor.data.identityAdmin)
          return failure("FORBIDDEN", "\u65E0\u8D26\u53F7\u6062\u590D\u6743\u9650");
        if (!isNewAccountPassword(password))
          return failure("INVALID_INPUT", "\u521D\u59CB\u5BC6\u7801\u81F3\u5C116\u4F4D\uFF0C\u4EC5\u5141\u8BB8\u82F1\u6587\u5B57\u6BCD\u548C\u6570\u5B57");
        try {
          const result3 = await repo.mutate(tokens.hash(token), input, void 0, await passwords.hash(password));
          return result3.ok ? success({}) : result3;
        } catch {
          return failure("UNAVAILABLE", "\u6062\u590D\u7528\u6237\u6682\u4E0D\u53EF\u7528");
        }
      }
      if (input.action === "user.update" || input.action === "product.update" || input.action === "navigator.update") {
        const command4 = input.action === "product.update" && input.role !== void 0 ? { ...input, ...productPermissionsFor(input.role) } : input;
        const result3 = await repo.mutate(tokens.hash(token), command4);
        return result3.ok ? success({}) : result3;
      }
      if (input.action === "user.delete") {
        const result3 = await repo.mutate(tokens.hash(token), { ...input, reason: input.reason?.trim() || "\u7528\u6237\u7BA1\u7406\u4E2D\u5FC3\u5220\u9664" });
        return result3.ok ? success({}) : result3;
      }
      if (typeof password !== "string" || password.length < AUTH_LIMITS.passwordMin || password.length > AUTH_LIMITS.passwordMax)
        return failure("INVALID_INPUT", "\u7BA1\u7406\u8BF7\u6C42\u65E0\u6548");
      const credentials = await authRepo.credential(actor.data.email);
      if (!credentials.ok)
        return credentials;
      let verified = false;
      try {
        verified = await passwords.verify(password, credentials.data?.passwordHash ?? "");
      } catch {
        return failure("UNAVAILABLE", "\u91CD\u65B0\u8BA4\u8BC1\u6682\u4E0D\u53EF\u7528");
      }
      if (!verified || !credentials.data?.active)
        return failure("UNAUTHORIZED", "\u91CD\u65B0\u8BA4\u8BC1\u5931\u8D25");
      if (input.action === "challenge.issue" || input.action === "user.reset-password") {
        const raw = tokens.create(), expiresAt = new Date(clock.now() + ADMIN_LIMITS.challenge_ttl_seconds * MILLISECONDS).toISOString();
        const command4 = input.action === "challenge.issue" ? { ...input, email: input.email.trim().toLowerCase() } : input;
        const result3 = await repo.mutate(
          tokens.hash(token),
          command4,
          { tokenHash: tokens.hash(raw), userId: input.action === "user.reset-password" ? input.userId : "", purpose: input.action === "user.reset-password" ? "recover" : input.purpose, expiresAt, email: input.action === "challenge.issue" ? input.email.trim().toLowerCase() : "", displayName: input.action === "challenge.issue" ? input.displayName.trim() : "" }
        );
        return result3.ok ? success({ challengeToken: raw, expiresAt }) : result3;
      }
      const result2 = await repo.mutate(tokens.hash(token), input);
      return result2.ok ? success({}) : result2;
    },
    async consume(input) {
      if (!object(input) || Object.keys(input).some((k) => k !== "token" && k !== "password") || typeof input.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.token) || !isNewAccountPassword(input.password))
        return failure("INVALID_INPUT", "\u5BC6\u7801\u81F3\u5C116\u4F4D\uFF0C\u4EC5\u5141\u8BB8\u82F1\u6587\u5B57\u6BCD\u548C\u6570\u5B57");
      try {
        return await repo.consume(tokens.hash(input.token), await passwords.hash(input.password));
      } catch {
        return failure("UNAVAILABLE", "\u5BC6\u7801\u8BBE\u7F6E\u6682\u4E0D\u53EF\u7528");
      }
    }
  };
}

// server/transport/admin-http.ts
var COOKIE = "milogin_admin";
var TOKEN = /^[A-Za-z0-9_-]{43}$/;
var CSRF = /^[a-f0-9]{64}$/;
function cookie(request2) {
  const matches = (request2.headers.cookie ?? "").split(";").map((v) => v.trim()).filter((v) => v.startsWith(`${COOKIE}=`));
  const value2 = matches.length === 1 ? matches[0].slice(COOKIE.length + 1) : "";
  return TOKEN.test(value2) ? value2 : "";
}
function sameOrigin(request2, config) {
  return request2.headers.origin === (config.public_origin ?? `http://${request2.headers.host}`) && request2.headers["sec-fetch-site"] !== "cross-site";
}
function record3(value2) {
  return !!value2 && typeof value2 === "object" && !Array.isArray(value2);
}
async function navigatorDashboard(config, token) {
  try {
    const response = await fetch(`${config.navigator_url.replace(/\/$/, "")}/api/center/navigator/dashboard`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(config.request_timeout_seconds * 1e3)
    });
    const payload = await response.json();
    if (response.ok && payload.ok === true && payload.data)
      return success({ ...payload.data, entryUrl: config.navigator_entry_url });
    if (response.status === 401)
      return failure("UNAUTHORIZED", "Navigator \u767B\u5F55\u72B6\u6001\u65E0\u6548");
    if (response.status === 403)
      return failure("FORBIDDEN", "\u5F53\u524D\u4E2D\u5FC3\u8D26\u53F7\u6CA1\u6709 Navigator \u7BA1\u7406\u6743\u9650");
    return failure("UNAVAILABLE", "Navigator \u670D\u52A1\u6682\u4E0D\u53EF\u7528");
  } catch {
    return failure("UNAVAILABLE", "Navigator \u670D\u52A1\u6682\u4E0D\u53EF\u7528");
  }
}
async function navigatorHealth(config) {
  try {
    const response = await fetch(`${config.navigator_url.replace(/\/$/, "")}/api/health/live`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(config.request_timeout_seconds * 1e3)
    });
    const payload = await response.json();
    if (response.ok && payload.ok === true && payload.data?.status === "ok")
      return { id: "navigator", label: "Navigator", state: "healthy", value: "\u6B63\u5E38", valueLabel: "\u670D\u52A1\u72B6\u6001", detail: `${payload.data.backend === "postgres" ? "PostgreSQL" : "\u4E1A\u52A1"}\u540E\u7AEF\u53EF\u7528` };
    return { id: "navigator", label: "Navigator", state: "offline", value: "\u5F02\u5E38", valueLabel: "\u670D\u52A1\u72B6\u6001", detail: "\u5065\u5EB7\u63A5\u53E3\u8FD4\u56DE\u5F02\u5E38" };
  } catch {
    return { id: "navigator", label: "Navigator", state: "offline", value: "\u79BB\u7EBF", valueLabel: "\u670D\u52A1\u72B6\u6001", detail: "\u6682\u65E0\u6CD5\u8FDE\u63A5 Navigator \u670D\u52A1" };
  }
}
function createAdminHandler(auth, admin, tokens, gate, config, staticHandler, passwordChange, dashboard, dataBrowser) {
  const cookieFlags = `HttpOnly; SameSite=Strict; Path=/` + (config.test_mode || config.local_http ? "" : "; Secure");
  return async (request2, response) => {
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const url = new URL(request2.url ?? "/", `http://${request2.headers.host}`), path4 = url.pathname, method = request2.method;
    if (!path4.startsWith("/admin-api/")) {
      if (method !== "GET" && method !== "HEAD") {
        send(response, failure("NOT_FOUND", "\u9875\u9762\u4E0D\u5B58\u5728"));
        return;
      }
      await staticHandler(request2, response);
      return;
    }
    const token = cookie(request2), csrf = token ? tokens.hash(`csrf:${token}`) : "", address = request2.socket.remoteAddress ?? "unknown";
    if (request2.headers.origin && !sameOrigin(request2, config) || request2.headers["sec-fetch-site"] === "cross-site") {
      send(response, failure("FORBIDDEN", "\u4E0D\u63A5\u53D7\u8DE8\u7AD9\u7BA1\u7406\u8BF7\u6C42"));
      return;
    }
    if (method === "POST" && !sameOrigin(request2, config)) {
      send(response, failure("FORBIDDEN", "\u7BA1\u7406\u64CD\u4F5C\u5FC5\u987B\u6765\u81EA\u540C\u6E90\u9875\u9762"));
      return;
    }
    if (method === "POST" && path4 !== ADMIN_ROUTES.login && path4 !== ADMIN_ROUTES.consume) {
      const submitted = request2.headers["x-csrf-token"];
      if (!token || typeof submitted !== "string" || !CSRF.test(submitted) || submitted !== csrf) {
        send(response, failure("FORBIDDEN", "\u7BA1\u7406\u64CD\u4F5C\u6821\u9A8C\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u9875\u9762"));
        return;
      }
    }
    if (method === "POST" && path4 === ADMIN_ROUTES.login) {
      const input = await body(request2, config.request_body_bytes);
      if (!input.ok) {
        send(response, input);
        return;
      }
      const email3 = record3(input.data) && typeof input.data.email === "string" ? input.data.email.trim().toLowerCase() : "invalid";
      if (!gate.allow(`browser-login:${email3}`, address)) {
        send(response, failure("RATE_LIMITED", "\u767B\u5F55\u5C1D\u8BD5\u8FC7\u591A\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5"));
        return;
      }
      const result2 = await auth.login(input.data, "browser");
      if (!result2.ok) {
        send(response, result2);
        return;
      }
      response.setHeader("Set-Cookie", `${COOKIE}=${result2.data.token}; ${cookieFlags}; Max-Age=${config.session_ttl_seconds}`);
      send(response, success({ identity: result2.data.identity, expiresAt: result2.data.expiresAt, csrf: tokens.hash(`csrf:${result2.data.token}`) }));
      return;
    }
    if (method === "POST" && path4 === ADMIN_ROUTES.consume) {
      if (!gate.allow("challenge-consume", address)) {
        send(response, failure("RATE_LIMITED", "\u5BC6\u7801\u8BBE\u7F6E\u5C1D\u8BD5\u8FC7\u591A"));
        return;
      }
      const input = await body(request2, config.request_body_bytes);
      send(response, input.ok ? await admin.consume(input.data) : input);
      return;
    }
    if (!token) {
      send(response, failure("UNAUTHORIZED", "\u8BF7\u5148\u767B\u5F55\u7BA1\u7406\u5E73\u53F0"));
      return;
    }
    if (method === "GET" && path4 === ADMIN_ROUTES.me) {
      const result2 = await auth.me(token, "browser");
      send(response, result2.ok ? success({ identity: result2.data, csrf }) : result2);
      return;
    }
    if (method === "POST" && path4 === ADMIN_ROUTES.logout) {
      const result2 = await auth.logout(token, "browser");
      response.setHeader("Set-Cookie", `${COOKIE}=; ${cookieFlags}; Max-Age=0`);
      send(response, result2);
      return;
    }
    if (method === "POST" && path4 === ADMIN_ROUTES.password) {
      if (!passwordChange) {
        send(response, failure("UNAVAILABLE", "\u6539\u5BC6\u670D\u52A1\u4E0D\u53EF\u7528"));
        return;
      }
      if (!gate.allow(`password-change:${tokens.hash(token)}`, address)) {
        send(response, failure("RATE_LIMITED", "\u6539\u5BC6\u5C1D\u8BD5\u8FC7\u591A"));
        return;
      }
      const input = await body(request2, config.request_body_bytes);
      const result2 = input.ok ? await passwordChange.change(token, input.data) : input;
      if (result2.ok)
        response.setHeader("Set-Cookie", `${COOKIE}=; ${cookieFlags}; Max-Age=0`);
      send(response, result2);
      return;
    }
    if (method === "GET" && path4 === ADMIN_ROUTES.users) {
      const limit = Number(url.searchParams.get("limit") ?? ADMIN_LIMITS.page), offset = Number(url.searchParams.get("offset") ?? 0);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > ADMIN_LIMITS.pageMax || !Number.isSafeInteger(offset) || offset < 0) {
        send(response, failure("INVALID_INPUT", "\u5206\u9875\u53C2\u6570\u65E0\u6548"));
        return;
      }
      send(response, await admin.users(token, { search: url.searchParams.get("search") ?? "", limit, offset, ...url.searchParams.has("productId") ? { productId: url.searchParams.get("productId") } : {}, ...url.searchParams.has("state") ? { state: url.searchParams.get("state") } : {} }));
      return;
    }
    if (method === "GET" && path4 === ADMIN_ROUTES.products) {
      send(response, await admin.products(token));
      return;
    }
    if (method === "GET" && path4 === ADMIN_ROUTES.dashboard) {
      send(response, dashboard ? await dashboard.dashboard(token) : failure("UNAVAILABLE", "\u6570\u636E\u770B\u677F\u6682\u4E0D\u53EF\u7528"));
      return;
    }
    if (method === "GET" && path4 === ADMIN_ROUTES.operations) {
      if (!dashboard) {
        send(response, failure("UNAVAILABLE", "\u7CFB\u7EDF\u8FD0\u884C\u670D\u52A1\u6682\u4E0D\u53EF\u7528"));
        return;
      }
      const result2 = await dashboard.operations(token);
      if (!result2.ok) {
        send(response, result2);
        return;
      }
      send(response, success({ ...result2.data, checks: [...result2.data.checks, await navigatorHealth(config)] }));
      return;
    }
    if (method === "GET" && path4 === ADMIN_ROUTES.data) {
      if (!dataBrowser) {
        send(response, failure("UNAVAILABLE", "\u6570\u636E\u6D4F\u89C8\u670D\u52A1\u6682\u4E0D\u53EF\u7528"));
        return;
      }
      if (!url.searchParams.has("table")) {
        send(response, await dataBrowser.tables(token));
        return;
      }
      const limit = Number(url.searchParams.get("limit") ?? ADMIN_DATA_BROWSER_LIMITS.page), offset = Number(url.searchParams.get("offset") ?? 0);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > ADMIN_DATA_BROWSER_LIMITS.pageMax || !Number.isSafeInteger(offset) || offset < 0) {
        send(response, failure("INVALID_INPUT", "\u5206\u9875\u53C2\u6570\u65E0\u6548"));
        return;
      }
      const rawDirection = url.searchParams.get("direction"), direction = rawDirection === null ? void 0 : rawDirection;
      if (direction !== void 0 && direction !== "asc" && direction !== "desc") {
        send(response, failure("INVALID_INPUT", "\u6392\u5E8F\u65B9\u5411\u65E0\u6548"));
        return;
      }
      const sort = url.searchParams.get("sort");
      send(response, await dataBrowser.page(token, { table: url.searchParams.get("table") ?? "", search: url.searchParams.get("search") ?? "", limit, offset, ...sort ? { sort } : {}, ...direction ? { direction } : {} }));
      return;
    }
    if (method === "GET" && path4 === ADMIN_ROUTES.navigatorDashboard) {
      send(response, await navigatorDashboard(config, token));
      return;
    }
    if (method === "GET" && path4 === ADMIN_ROUTES.sessions) {
      send(response, await admin.sessions(token, url.searchParams.get("userId") ?? ""));
      return;
    }
    if (method === "GET" && path4 === ADMIN_ROUTES.audit) {
      send(response, await admin.audit(token, url.searchParams.get("productId") ?? void 0, url.searchParams.get("userId") ?? void 0));
      return;
    }
    if (method === "POST" && path4 === ADMIN_ROUTES.mutate) {
      if (!gate.allow(`management:${tokens.hash(token)}`, address)) {
        send(response, failure("RATE_LIMITED", "\u91CD\u65B0\u8BA4\u8BC1\u5C1D\u8BD5\u8FC7\u591A"));
        return;
      }
      const input = await body(request2, config.request_body_bytes);
      if (!input.ok) {
        send(response, input);
        return;
      }
      if (!record3(input.data) || Object.keys(input.data).some((k) => k !== "command" && k !== "password")) {
        send(response, failure("INVALID_INPUT", "\u7BA1\u7406\u8BF7\u6C42\u65E0\u6548"));
        return;
      }
      if (record3(input.data.command) && input.data.command.action === "challenge.issue" && !config.test_mode) {
        send(response, failure("FORBIDDEN", "\u8D26\u53F7\u6FC0\u6D3B\u94FE\u63A5\u4EC5\u7528\u4E8E\u672C\u673A\u5F00\u901A\u6D41\u7A0B"));
        return;
      }
      send(response, await admin.mutate(token, input.data.command, input.data.password));
      return;
    }
    send(response, failure("NOT_FOUND", "\u7BA1\u7406\u63A5\u53E3\u4E0D\u5B58\u5728"));
  };
}

// server/adapters/admin-static.ts
var import_promises2 = require("node:fs/promises");
var import_node_path4 = require("node:path");
var TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff" };
function inside(root, path4) {
  const part = (0, import_node_path4.relative)(root, path4);
  return part !== "" && !part.startsWith("..") && !(0, import_node_path4.isAbsolute)(part);
}
function createAdminStatic(root = (0, import_node_path4.resolve)(__dirname, "../../dist-admin")) {
  return async (request2, response) => {
    try {
      const pathname = new URL(request2.url ?? "/", `http://${request2.headers.host}`).pathname;
      const asset = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
      if (asset !== "index.html" && !/^assets\/[A-Za-z0-9_.-]+$/.test(asset)) {
        send(response, failure("NOT_FOUND", "\u9875\u9762\u4E0D\u5B58\u5728"));
        return;
      }
      const base = await (0, import_promises2.realpath)(root), file = await (0, import_promises2.realpath)((0, import_node_path4.resolve)(base, asset));
      const contentType = TYPES[(0, import_node_path4.extname)(file)];
      if (!inside(base, file) || !contentType || !(await (0, import_promises2.stat)(file)).isFile()) {
        send(response, failure("NOT_FOUND", "\u9875\u9762\u4E0D\u5B58\u5728"));
        return;
      }
      const content = await (0, import_promises2.readFile)(file);
      response.writeHead(200, { "Content-Type": contentType, "Content-Length": content.length, "X-Content-Type-Options": "nosniff", "Cache-Control": asset === "index.html" ? "no-store" : "public, max-age=31536000, immutable" });
      response.end(request2.method === "HEAD" ? void 0 : content);
    } catch {
      send(response, failure("NOT_FOUND", "\u7BA1\u7406\u9875\u9762\u5C1A\u672A\u6784\u5EFA\u6216\u8D44\u6E90\u4E0D\u5B58\u5728"));
    }
  };
}

// server/services/password-change.ts
function createPasswordChangeService(repo, authRepo, passwords, tokens, auth) {
  return { async change(token, input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      return failure("INVALID_INPUT", "\u6539\u5BC6\u8BF7\u6C42\u65E0\u6548");
    const value2 = input;
    if (Object.keys(value2).some((k) => k !== "currentPassword" && k !== "newPassword") || typeof value2.currentPassword !== "string" || !value2.currentPassword.length || value2.currentPassword.length > AUTH_LIMITS.passwordMax || !isNewAccountPassword(value2.newPassword) || value2.newPassword === value2.currentPassword)
      return failure("INVALID_INPUT", "\u65B0\u5BC6\u7801\u81F3\u5C116\u4F4D\uFF0C\u4EC5\u5141\u8BB8\u82F1\u6587\u5B57\u6BCD\u548C\u6570\u5B57\uFF0C\u4E14\u5FC5\u987B\u4E0E\u5F53\u524D\u5BC6\u7801\u4E0D\u540C");
    const identity = await auth.me(token, "browser");
    if (!identity.ok)
      return identity;
    const credential = await authRepo.credential(identity.data.email);
    if (!credential.ok)
      return credential;
    if (!credential.data?.active)
      return failure("UNAUTHORIZED", "\u4F1A\u8BDD\u5DF2\u5931\u6548");
    try {
      if (!await passwords.verify(value2.currentPassword, credential.data.passwordHash))
        return failure("UNAUTHORIZED", "\u5F53\u524D\u5BC6\u7801\u4E0D\u6B63\u786E");
      return await repo.changePassword(tokens.hash(token), credential.data.passwordHash, credential.data.securityRevision, await passwords.hash(value2.newPassword));
    } catch {
      return failure("UNAVAILABLE", "\u6539\u5BC6\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
    }
  } };
}

// server/adapters/postgres/flat-lead-import.ts
var import_node_crypto9 = require("node:crypto");

// server/adapters/postgres/contact-mail-projection-sql.ts
function effectiveMailFactSql(alias = "mf") {
  return `NOT ${alias}.archive_only AND NOT EXISTS(
    SELECT 1 FROM crm_contact_mail_events mc
    WHERE mc.actor_id=${alias}.actor_id AND mc.mailbox_key=${alias}.mailbox_key
      AND mc.message_key=${alias}.message_key AND mc.contact_id=${alias}.contact_id
      AND mc.customer_id=${alias}.customer_id AND mc.classification_revision IS NOT NULL
      AND mc.classification_revision>COALESCE(${alias}.classification_revision,0)
  )`;
}
function effectiveActivitySql(alias = "act") {
  return `NOT EXISTS(
    SELECT 1 FROM crm_contact_mail_events mf
    WHERE mf.activity_id=${alias}.id AND NOT (${effectiveMailFactSql("mf")})
  )`;
}
function lastEffectiveFollowupSql(field) {
  const validMail = `(
    mf.kind='replied' AND mf.direction='inbound' AND lower(mf.from_email)=lower(ct.email)
      AND jsonb_array_length(mf.to_emails)>0
    OR mf.kind='sent' AND mf.direction='outbound' AND mf.to_emails ? lower(ct.email)
      AND lower(mf.from_email)<>lower(ct.email)
  )`;
  return `(SELECT current_followup.${field} FROM (
    SELECT act.occurred_at,act.note,act.recorded_at,TRUE AS manual,act.id::text AS fact_id
    FROM crm_shared_activities act
    WHERE act.contact_id=ct.id AND act.customer_id=c.customer_id AND act.opportunity_id IS NULL
      AND act.method IN ('email','phone','visit','other')
      AND NOT EXISTS(SELECT 1 FROM crm_contact_mail_events ma WHERE ma.activity_id=act.id)
    UNION ALL
    SELECT mf.occurred_at,COALESCE(NULLIF(mf.subject,''),mf.preview) AS note,
      mf.recorded_at,FALSE AS manual,mf.event_id::text AS fact_id
    FROM crm_contact_mail_events mf
    WHERE mf.contact_id=ct.id AND mf.customer_id=c.customer_id
      AND ${validMail} AND ${effectiveMailFactSql()}
  ) current_followup
  ORDER BY occurred_at DESC,manual DESC,recorded_at DESC,fact_id DESC LIMIT 1)`;
}

// server/core/contact-mail-projection.ts
var TOUCH_STATUS = { replied: "replied", contacted: "reached", bounced: "bounced", autoreply: "autoreply", uncontacted: "" };
function projectContactMail(primary, mail, manual) {
  const timeline = [];
  const email3 = primary?.toLowerCase();
  for (const fact of mail) {
    const reply = fact.kind === "replied" && fact.direction === "inbound" && fact.fromEmail.toLowerCase() === email3 && fact.toEmails.length > 0;
    const sent = fact.kind === "sent" && fact.direction === "outbound" && fact.toEmails.some((recipient) => recipient.toLowerCase() === email3) && fact.fromEmail.toLowerCase() !== email3;
    const status2 = fact.kind === "bounced" ? "bounced" : fact.kind === "autoreply" ? "autoreply" : reply ? "replied" : sent ? "reached" : null;
    const touch = reply ? "replied" : fact.kind === "bounced" ? "bounced" : fact.kind === "autoreply" ? "autoreply" : sent ? "contacted" : null;
    timeline.push({ ...fact, manual: false, status: status2, touch });
  }
  for (const fact of manual) {
    timeline.push({
      ...fact,
      manual: true,
      touch: fact.contactStatus,
      status: TOUCH_STATUS[fact.contactStatus]
    });
  }
  timeline.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || Number(a.manual) - Number(b.manual) || Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  let touchStatus = "uncontacted";
  let status = "";
  for (const fact of timeline) {
    if (fact.touch && (fact.manual || !(fact.touch === "contacted" && ["replied", "bounced", "autoreply"].includes(touchStatus)))) {
      touchStatus = fact.touch;
    }
    if (fact.status !== null && !(fact.status === "reached" && !fact.manual && touchStatus === "replied")) {
      status = fact.status;
    }
  }
  return { status, touchStatus };
}

// server/adapters/postgres/contact-mail-correction-repository.ts
async function correctionRevisionIn(client, actorId, input) {
  if (!input.correction)
    return success(null);
  const correction = input.correction;
  const kind = correction.classification === "other" ? "received" : correction.classification;
  if (input.direction !== "inbound" || input.advanceSendStage !== void 0 || input.kind !== kind) {
    return failure("INVALID_INPUT", "\u5206\u7C7B\u66F4\u6B63\u4EC5\u5141\u8BB8\u6536\u4EF6\u4E8B\u5B9E");
  }
  const params = [actorId, input.mailboxKey, input.messageKey, input.contactId, input.customerId];
  const stream = "actor_id=$1 AND mailbox_key=$2 AND message_key=$3 AND contact_id=$4 AND customer_id=$5";
  const head = (await client.query(`
    SELECT event_key,classification_revision,occurred_at,from_email,to_emails,cc_emails
    FROM crm_contact_mail_events WHERE ${stream} AND classification_revision IS NOT NULL
    ORDER BY classification_revision DESC LIMIT 1`, params)).rows[0];
  if ((head?.event_key ?? null) !== correction.previousEventKey) {
    return failure("CONFLICT", "\u90AE\u4EF6\u5206\u7C7B\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5");
  }
  const original = head ?? (await client.query(`
    SELECT occurred_at,from_email,to_emails,cc_emails FROM crm_contact_mail_events
    WHERE ${stream} AND direction='inbound' ORDER BY recorded_at,event_id LIMIT 1`, params)).rows[0];
  if (original && (new Date(original.occurred_at).toISOString() !== new Date(input.occurredAt).toISOString() || original.from_email.toLowerCase() !== input.fromEmail.toLowerCase() || JSON.stringify(original.to_emails) !== JSON.stringify(input.toEmails) || JSON.stringify(original.cc_emails) !== JSON.stringify(input.ccEmails))) {
    return failure("CONFLICT", "\u5206\u7C7B\u66F4\u6B63\u4E0D\u80FD\u6539\u53D8\u539F\u90AE\u4EF6\u65F6\u95F4\u6216\u6536\u53D1\u4EBA");
  }
  return success((head?.classification_revision ?? 0) + 1);
}
async function refreshMailProjectionIn(client, input, primary) {
  const params = [input.contactId, input.customerId];
  const corrections = await client.query(`
    SELECT 1 FROM crm_contact_mail_events
    WHERE contact_id=$1 AND customer_id=$2 AND classification_revision IS NOT NULL LIMIT 1`, params);
  if (!corrections.rowCount)
    return;
  const facts = await client.query(`
    SELECT kind,direction,occurred_at AS "occurredAt",recorded_at AS "recordedAt",
      from_email AS "fromEmail",to_emails AS "toEmails"
    FROM crm_contact_mail_events mf
    WHERE contact_id=$1 AND customer_id=$2 AND ${effectiveMailFactSql()}`, params);
  const manual = await client.query(`
    SELECT act.contact_status AS "contactStatus",act.occurred_at AS "occurredAt",act.recorded_at AS "recordedAt"
    FROM crm_shared_activities act
    WHERE act.contact_id=$1 AND act.customer_id=$2 AND act.opportunity_id IS NULL
      AND act.contact_status IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM crm_contact_mail_events mf WHERE mf.activity_id=act.id)`, params);
  const occurrence3 = (fact) => ({
    ...fact,
    occurredAt: new Date(fact.occurredAt).toISOString(),
    recordedAt: new Date(fact.recordedAt).toISOString()
  });
  const projected = projectContactMail(primary, facts.rows.map(occurrence3), manual.rows.map(occurrence3));
  await client.query(
    "UPDATE contacts SET status=$2,crm_touch_status=$3 WHERE id=$1",
    [input.contactId, projected.status, projected.touchStatus]
  );
}

// server/core/contact-permissions.ts
var FULL_FIELDS = ["email", ...CONTACT_SHARED_FIELDS, "sourceLevel1", "sourceLevel2", "tags", "preferences"];
function globalContactActor(a) {
  return a.roles.includes("admin") && ["shared", "summary"].includes(a.scope) && a.capabilities.includes("leads.read.all");
}
function sourceContactManager(a, r) {
  return r.origin === "operations" && a.roles.some((x) => x === "operations" || x === "admin") && ["shared", "summary"].includes(a.scope) && a.capabilities.includes("leads.assign");
}
function contactPermissions(a, r) {
  const develop = a.capabilities.includes("leads.develop"), full = globalContactActor(a) || sourceContactManager(a, r) || r.origin === "personal" && r.ownerUserId === a.userId;
  const owner = r.ownerUserId === a.userId, grant2 = r.shared_grant, allowed = develop && (full || owner || !!grant2);
  const editableFields = (!allowed ? [] : full ? [...FULL_FIELDS] : owner ? [...CONTACT_SHARED_FIELDS, "preferences"] : grant2?.editableFields.filter((f) => CONTACT_SHARED_FIELDS.includes(f)) ?? []).filter((field) => field !== "clientType" && field !== "country");
  return { editableFields, canFollowup: allowed && (full || owner || !!grant2?.canFollowup), canChangeStage: allowed && (full || owner || !!grant2?.canChangeStage), canSendMail: allowed && !r.development_restriction?.trim(), canShare: develop && owner && r.origin === "operations" && r.active_assignment_status === "accepted" && !r.development_restriction?.trim() };
}

// server/adapters/postgres/contact-sharing-sql.ts
function validShareSql(ownerSql, alias = "sh") {
  return `${alias}.grantor_user_id=${ownerSql} AND c.origin='operations' AND EXISTS(SELECT 1 FROM public.identity_users gu JOIN public.identity_product_access ga ON ga.user_id=gu.user_id AND ga.product_id='crm' AND ga.active JOIN public.identity_product_grants gg ON gg.user_id=gu.user_id AND gg.product_id='crm' AND gg.active AND gg.role='sales' WHERE gu.user_id=${alias}.grantor_user_id AND gu.active AND NOT gu.must_change_password AND ga.scope IN ('own','shared','summary') AND (ga.capabilities IS NULL OR ga.capabilities ? 'leads.develop'))`;
}
function sharedAccessSql(actorSql, ownerSql) {
  return `EXISTS(SELECT 1 FROM crm_contact_shares sh WHERE sh.contact_id=ct.id AND sh.customer_id=c.customer_id AND sh.target_user_id=${actorSql} AND sh.status='accepted' AND EXISTS(SELECT 1 FROM public.identity_product_grants tg WHERE tg.user_id=sh.target_user_id AND tg.product_id='crm' AND tg.role='sales' AND tg.active) AND ${validShareSql(ownerSql)})`;
}

// server/adapters/postgres/contact-assignment-repository.ts
var import_node_crypto8 = require("node:crypto");

// server/core/contact-assignments.ts
var CONTACT_ASSIGNMENT_ROUTES = { assignments: "/api/crm/contact-assignments", groups: "/api/crm/contact-assignments/groups", contact: "/api/crm/contacts" };
var CONTACT_ASSIGNMENT_LIMITS = { batch: 200, page: 50, pageMax: 100, notify: 20, text: 500, note: 2e4, key: 128, preferences: 10, preferenceText: 200 };
var CONTACT_ASSIGNMENT_EVENTS = { requested: "crm.contact.assignment.requested", accepted: "crm.contact.assignment.accepted", rejected: "crm.contact.assignment.rejected", cancelled: "crm.contact.assignment.cancelled", updated: "crm.contact.updated", followup: "crm.contact.followup" };
function isContactAssignmentTarget(member, actorId) {
  return member.userId !== actorId && member.active !== false && member.roles.includes("sales") && member.capabilities.includes("leads.develop");
}

// server/adapters/postgres/contact-mail-repository.ts
var import_node_crypto6 = require("node:crypto");
var MILLISECONDS_PER_SECOND6 = 1e3;
var SELECT = `event_id AS "eventId",actor_id AS "actorId",contact_id AS "contactId",customer_id AS "customerId",event_key AS "eventKey",mailbox_key AS "mailboxKey",message_key AS "messageKey",kind,direction,occurred_at AS "occurredAt",subject,preview,from_email AS "fromEmail",to_emails AS "toEmails",cc_emails AS "ccEmails",recorded_at AS "recordedAt",activity_id::text AS "activityId",classification_correction AS correction,classification_revision AS "correctionRevision"`;
function mapped(row2) {
  const { correction, correctionRevision, ...event3 } = row2;
  return { ...event3, ...correction ? { correction } : {}, ...correctionRevision ? { correctionRevision } : {}, occurredAt: new Date(row2.occurredAt).toISOString(), recordedAt: new Date(row2.recordedAt).toISOString() };
}
async function contactMailEventsIn(client, input) {
  const rows = await client.query(`SELECT ${SELECT} FROM crm_contact_mail_events WHERE contact_id=$1 AND customer_id=$2 ORDER BY occurred_at DESC,recorded_at DESC,event_id DESC LIMIT $3`, [input.contactId, input.customerId, CONTACT_MAIL_LIMITS.history]);
  return rows.rows.map(mapped);
}
function contactMailFingerprint(input) {
  const fields = [input.contactId, input.customerId, input.eventKey, input.mailboxKey, input.messageKey, input.kind, input.direction, input.occurredAt, input.subject, input.preview, input.fromEmail, input.toEmails, input.ccEmails];
  if (input.correction)
    fields.push([input.correction.previousEventKey, input.correction.classification]);
  return (0, import_node_crypto6.createHash)("sha256").update(JSON.stringify(fields)).digest("hex");
}
async function recordContactMailEventIn(client, actor, input) {
  if (input.advanceSendStage !== void 0 && (typeof input.advanceSendStage !== "boolean" || input.kind !== "sent" || input.direction !== "outbound"))
    return failure("INVALID_INPUT", "\u53D1\u9001\u8F6E\u6B21\u4EC5\u5141\u8BB8\u5DF2\u786E\u8BA4\u7684\u53D1\u51FA\u4E8B\u4EF6\u63A8\u8FDB");
  const contact2 = await contact(client, input, true);
  if (!contact2 || !read(actor, contact2) || !contactPermissionsFor(actor, contact2).canSendMail)
    return failure("NOT_FOUND", "\u8054\u7CFB\u4EBA\u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u8DDF\u8FDB");
  const primary = contact2.email?.trim().toLowerCase();
  const matchingSent = primary && input.kind === "sent" && input.direction === "outbound" && input.toEmails.some((email3) => email3.toLowerCase() === primary) && input.fromEmail.toLowerCase() !== primary;
  if (input.advanceSendStage && !matchingSent)
    return failure("INVALID_INPUT", "\u53D1\u9001\u7ED3\u679C\u6536\u4EF6\u4EBA\u4E0E\u5F53\u524D\u8054\u7CFB\u4EBA\u90AE\u7BB1\u4E0D\u4E00\u81F4");
  const advanceStage = async () => {
    await client.query("UPDATE contacts SET stage=CASE stage WHEN 'cold' THEN 'f1' WHEN 'f1' THEN 'f2' WHEN 'f2' THEN 'f3' WHEN 'f3' THEN 'f4' ELSE stage END WHERE id=$1", [input.contactId]);
  };
  const fingerprint2 = contactMailFingerprint(input), old = (await client.query(`SELECT ${SELECT},digest,send_stage_advanced,archive_only FROM crm_contact_mail_events WHERE actor_id=$1 AND event_key=$2 FOR UPDATE`, [actor.userId, input.eventKey])).rows[0];
  if (old) {
    if (old.digest !== fingerprint2)
      return failure("CONFLICT", "\u90AE\u4EF6\u4E8B\u4EF6\u952E\u5DF2\u7528\u4E8E\u4E0D\u540C\u4E8B\u5B9E");
    if (input.advanceSendStage && !old.send_stage_advanced && !old.archive_only) {
      await advanceStage();
      await client.query("UPDATE crm_contact_mail_events SET send_stage_advanced=true WHERE event_id=$1", [old.eventId]);
      await client.query("UPDATE contacts SET crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1", [input.contactId]);
      await contactEvent(client, actor, contact2, CONTACT_ASSIGNMENT_EVENTS.followup, (contact2.contactVersion ?? 1) + 1, void 0, old.eventId);
    }
    const detail2 = await contactDetailIn(client, actor, input);
    if (!detail2.ok)
      return detail2;
    const { digest: _digest, send_stage_advanced: _advanced, archive_only: _archived, ...event3 } = old;
    return success({ eventId: old.eventId, duplicate: true, event: mapped(event3), contact: detail2.data.contact });
  }
  const recorded = (await client.query("SELECT clock_timestamp() AS stamp")).rows[0].stamp, occurred = new Date(input.occurredAt);
  if (!Number.isFinite(occurred.getTime()) || occurred.getTime() > recorded.getTime() + FOLLOWUP_TIME_LIMITS.future_skew_seconds * MILLISECONDS_PER_SECOND6)
    return failure("INVALID_INPUT", "\u90AE\u4EF6\u53D1\u751F\u65F6\u95F4\u65E0\u6548");
  const revision = await correctionRevisionIn(client, actor.userId, input);
  if (!revision.ok)
    return revision;
  const touch = primary && input.kind === "replied" && input.direction === "inbound" && input.fromEmail.toLowerCase() === primary && input.toEmails.length > 0 ? "replied" : primary && input.kind === "bounced" ? "bounced" : primary && input.kind === "autoreply" ? "autoreply" : matchingSent ? "contacted" : null;
  let activityId = null;
  const correctedStream = input.correction || (await client.query(
    `
    SELECT 1 FROM crm_contact_mail_events
    WHERE actor_id=$1 AND mailbox_key=$2 AND message_key=$3 AND contact_id=$4 AND customer_id=$5
      AND classification_revision IS NOT NULL LIMIT 1`,
    [actor.userId, input.mailboxKey, input.messageKey, input.contactId, input.customerId]
  )).rowCount;
  if (touch && !correctedStream) {
    const latest = (await client.query("SELECT max(occurred_at) AS stamp FROM crm_shared_activities WHERE contact_id=$1 AND customer_id=$2 AND opportunity_id IS NULL AND contact_status IS NOT NULL AND method IN ('email','phone','visit','other')", [input.contactId, input.customerId])).rows[0].stamp;
    activityId = (await client.query("INSERT INTO crm_shared_activities(customer_id,interaction_id,actor_id,note,method,occurred_at,recorded_at,created_at,contact_id,contact_status) VALUES($1,NULL,$2,$3,'email',$4,$5,$5,$6,$7) RETURNING id::text", [input.customerId, actor.userId, input.subject || input.preview, occurred, recorded, input.contactId, touch])).rows[0].id;
    if (!(touch === "contacted" && ["replied", "bounced", "autoreply"].includes(contact2.touchStatus)) && (!latest || occurred.getTime() > new Date(latest).getTime() || occurred.getTime() === new Date(latest).getTime() && contact2.touchStatus !== touch))
      await client.query("UPDATE contacts SET crm_touch_status=$2 WHERE id=$1", [input.contactId, touch]);
  }
  const classification = input.kind === "bounced" ? "bounced" : input.kind === "autoreply" ? "autoreply" : touch === "replied" ? "replied" : touch === "contacted" && contact2.touchStatus !== "replied" ? "reached" : null;
  if (classification) {
    const newer = (await client.query("SELECT 1 FROM crm_contact_mail_events WHERE contact_id=$1 AND customer_id=$2 AND NOT archive_only AND occurred_at>$3 UNION ALL SELECT 1 FROM crm_shared_activities WHERE contact_id=$1 AND customer_id=$2 AND contact_status IS NOT NULL AND occurred_at>$3 LIMIT 1", [input.contactId, input.customerId, occurred])).rowCount;
    if (!newer)
      await client.query("UPDATE contacts SET status=$2 WHERE id=$1", [input.contactId, classification]);
  }
  const eventId = (0, import_node_crypto6.randomUUID)();
  await client.query("INSERT INTO crm_contact_mail_events(event_id,actor_id,contact_id,customer_id,event_key,mailbox_key,message_key,kind,direction,occurred_at,subject,preview,from_email,to_emails,cc_emails,digest,recorded_at,activity_id,classification_correction,classification_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19::jsonb,$20)", [eventId, actor.userId, input.contactId, input.customerId, input.eventKey, input.mailboxKey, input.messageKey, input.kind, input.direction, occurred, input.subject, input.preview, input.fromEmail, JSON.stringify(input.toEmails), JSON.stringify(input.ccEmails), fingerprint2, recorded, activityId, input.correction ? JSON.stringify(input.correction) : null, revision.data]);
  if (input.advanceSendStage) {
    await advanceStage();
    await client.query("UPDATE crm_contact_mail_events SET send_stage_advanced=true WHERE event_id=$1", [eventId]);
  }
  await refreshMailProjectionIn(client, input, contact2.email);
  await client.query("UPDATE contacts SET crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1", [input.contactId]);
  await contactEvent(client, actor, contact2, CONTACT_ASSIGNMENT_EVENTS.followup, (contact2.contactVersion ?? 1) + 1, activityId ?? void 0, eventId);
  const detail = await contactDetailIn(client, actor, input);
  if (!detail.ok)
    return detail;
  return success({ eventId, duplicate: false, contact: detail.data.contact, event: { ...input, eventId, actorId: actor.userId, recordedAt: recorded.toISOString(), occurredAt: occurred.toISOString(), activityId, ...revision.data ? { correctionRevision: revision.data } : {} } });
}

// server/adapters/postgres/contact-assignment-group-schema.ts
var import_node_crypto7 = require("node:crypto");
var CONTACT_ASSIGNMENT_GROUP_VERSION = "050-contact-assignment-groups";
var CONTACT_ASSIGNMENT_GROUP_SQL = `
CREATE TABLE IF NOT EXISTS crm_contact_assignment_group_members(
 group_id uuid NOT NULL,
 request_id uuid PRIMARY KEY REFERENCES crm_contact_assignment_requests(request_id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_contact_assignment_group_member ON crm_contact_assignment_group_members(group_id,request_id);
`;
async function migrateContactAssignmentGroups(c) {
  const checksum = (0, import_node_crypto7.createHash)("sha256").update(CONTACT_ASSIGNMENT_GROUP_SQL).digest("hex");
  const old = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [CONTACT_ASSIGNMENT_GROUP_VERSION]);
  if (old.rows.length && old.rows[0].checksum !== checksum)
    return failure("CONFLICT", "\u5206\u914D\u7EC4\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
  if (!old.rows.length) {
    await c.query(CONTACT_ASSIGNMENT_GROUP_SQL);
    await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [CONTACT_ASSIGNMENT_GROUP_VERSION, checksum]);
  }
  return success(void 0);
}

// server/adapters/postgres/contact-assignment-repository.ts
var MILLISECONDS_PER_SECOND7 = 1e3;
var FOLLOWUP_LEGACY_STATUS = { contacted: "reached", replied: "replied", bounced: "bounced", autoreply: "autoreply", uncontacted: "" };
var CONTACT_OWNER_SQL = "COALESCE((SELECT ar.target_user_id FROM crm_contact_assignment_requests ar WHERE ar.contact_id=ct.id AND ar.status='accepted'),c.owner_user_id)";
var JOINS = `FROM contacts ct JOIN crm_customer_contacts cc ON cc.contact_id=ct.id JOIN crm_customers c ON c.customer_id=cc.customer_id JOIN companies co ON co.id=c.company_id`;
var LAST_FOLLOWUP_AT = lastEffectiveFollowupSql("occurred_at");
var LAST_FOLLOWUP_NOTE = lastEffectiveFollowupSql("note");
var PROJECTION = `ct.id AS "contactId",c.customer_id AS "customerId",c.version AS "customerVersion",ct.crm_contact_version AS "contactVersion",co.id AS "companyId",co.name AS "companyName",co.industry AS "businessType",co.domain AS website,ct.email,ct.first_name AS "firstName",ct.last_name AS "lastName",ct.title,ct.phone,ct.whatsapp,ct.linkedin AS "linkedinUrl",COALESCE(co.country,ct.country) AS country,COALESCE(CASE co.customer_type WHEN '\u4EE3\u7406' THEN 'agent' WHEN '\u76F4\u5BA2' THEN 'direct' END,ct.client_type) AS "clientType",ct.language,ct.stage,ct.status,ct.tags,ct.extra,ct.crm_touch_status AS "touchStatus",ct.assignee,ct.source,ct.source_detail AS "sourceDetail",ct.source_level1 AS "sourceLevel1",ct.source_level2 AS "sourceLevel2",ct.created_at AS "createdAt",ct.updated_at AS "updatedAt",${CONTACT_OWNER_SQL} AS "ownerUserId",(SELECT u.display_name FROM public.identity_users u WHERE u.user_id=${CONTACT_OWNER_SQL}) AS "ownerName",c.origin,c.state,c.created_by,c.development_restriction,(SELECT COALESCE(jsonb_agg(jsonb_build_object('targetUserId',sh.target_user_id,'editableFields',sh.editable_fields,'canFollowup',sh.can_followup,'canChangeStage',sh.can_change_stage)),'[]'::jsonb) FROM crm_contact_shares sh WHERE sh.contact_id=ct.id AND sh.customer_id=c.customer_id AND sh.status='accepted' AND EXISTS(SELECT 1 FROM public.identity_product_grants tg WHERE tg.user_id=sh.target_user_id AND tg.product_id='crm' AND tg.role='sales' AND tg.active) AND ${validShareSql(CONTACT_OWNER_SQL)}) AS shared_grants,(SELECT ar.status FROM crm_contact_assignment_requests ar WHERE ar.contact_id=ct.id AND ar.status IN ('pending','accepted')) AS active_assignment_status,(SELECT act.stage FROM crm_shared_activities act WHERE act.contact_id=ct.id AND act.customer_id=c.customer_id AND act.stage IS NOT NULL ORDER BY act.occurred_at DESC,act.id DESC LIMIT 1) AS "relationshipStage",${LAST_FOLLOWUP_AT} AS "lastFollowupAt",${LAST_FOLLOWUP_NOTE} AS "lastFollowupNote"`;
function contactPermissionsFor(a, row2) {
  return contactPermissions(a, { ...row2, shared_grant: row2.shared_grants?.find((g) => g.targetUserId === a.userId) });
}
function contactManager(a) {
  return ["shared", "summary"].includes(a.scope) && a.roles.some((r) => r === "admin" || r === "operations") && a.capabilities.includes("leads.assign");
}
function all(a) {
  return a.roles.includes("admin") && ["shared", "summary"].includes(a.scope) && a.capabilities.includes("leads.read.all");
}
function ownManager(a, row2) {
  return sourceContactManager(a, row2);
}
function read(a, row2) {
  return all(a) || ownManager(a, row2) || a.capabilities.includes("leads.develop") && (row2.ownerUserId === a.userId || !!row2.shared_grants?.some((g) => g.targetUserId === a.userId));
}
function edit(a, row2) {
  return contactPermissionsFor(a, row2).editableFields.length > 0;
}
function assign(a, row2) {
  return contactManager(a) && row2.origin === "operations" && !row2.development_restriction?.trim() && row2.ownerUserId === null && !row2.active_assignment_status;
}
function canDeleteContact(a, row2) {
  return row2.active_assignment_status !== "pending" && (all(a) || ownManager(a, row2) || row2.origin === "personal" && row2.ownerUserId === a.userId && a.capabilities.includes("leads.develop"));
}
function mapped2(a, row2) {
  const { created_by: _, development_restriction: __, active_assignment_status: ___, shared_grants: ____, ...ct } = row2;
  const permissions = contactPermissionsFor(a, row2);
  return { ...ct, assignmentStatus: row2.active_assignment_status, relationshipStage: ct.relationshipStage ?? (["contacted", "replied", "bounced", "autoreply"].includes(ct.touchStatus) ? "reaching" : "cold"), lastFollowupAt: ct.lastFollowupAt ? new Date(ct.lastFollowupAt).toISOString() : null, lastFollowupNote: ct.lastFollowupNote ?? null, createdAt: new Date(ct.createdAt).toISOString(), updatedAt: new Date(ct.updatedAt).toISOString(), canDelete: canDeleteContact(a, row2), permissions, isShared: !!row2.shared_grants?.some((g) => g.targetUserId === a.userId) && row2.ownerUserId !== a.userId, canSendMail: permissions.canSendMail, canEdit: edit(a, row2), canFollowup: permissions.canFollowup, canAssign: assign(a, row2) };
}
async function contact(c, input, lock = false, includeDeleted = false) {
  return (await c.query(`SELECT ${PROJECTION} ${JOINS} WHERE ct.id=$1 AND c.customer_id=$2 AND co.crm_deleted_at IS NULL ${includeDeleted ? "" : "AND ct.crm_deleted_at IS NULL"} ${lock ? "FOR UPDATE OF ct,c" : ""}`, [input.contactId, input.customerId])).rows[0];
}
async function contactDetailIn(c, a, input) {
  const ct = await contact(c, input);
  if (!ct || !read(a, ct))
    return failure("NOT_FOUND", "\u8054\u7CFB\u4EBA\u4E0D\u5B58\u5728");
  const co = (await c.query('SELECT customer_type AS "customerType",industry,country,size,updated_at::text AS revision,domain,backcheck_data AS "backcheckData" FROM companies WHERE id=$1', [ct.companyId])).rows[0];
  const activities = await c.query(`SELECT act.id::text,(SELECT mf.event_id::text FROM crm_contact_mail_events mf WHERE mf.activity_id=act.id LIMIT 1) AS "mailEventId",NOT (${effectiveActivitySql()}) AS "mailSuperseded",act.actor_id AS "actorId",u.display_name AS "actorName",act.note,act.stage,act.method,act.contact_id AS "contactId",act.contact_status AS "contactStatus",act.created_at AS "createdAt",act.occurred_at AS "occurredAt",act.recorded_at AS "recordedAt",ct.first_name AS "contactName" FROM crm_shared_activities act LEFT JOIN public.identity_users u ON u.user_id=act.actor_id LEFT JOIN contacts ct ON ct.id=act.contact_id WHERE act.customer_id=$1 AND act.contact_id=$2 AND act.opportunity_id IS NULL ORDER BY act.occurred_at DESC,act.id DESC`, [input.customerId, input.contactId]);
  return success({ contact: mapped2(a, ct), company: { companyId: ct.companyId, name: ct.companyName, domain: co.domain, backcheckData: co.backcheckData, customerType: co.customerType, industry: co.industry, country: co.country, size: co.size, revision: co.revision, canEdit: await companyEditable(c, a, ct) }, activities: activities.rows.map((x) => ({ ...x, createdAt: new Date(x.createdAt).toISOString(), occurredAt: new Date(x.occurredAt).toISOString(), recordedAt: new Date(x.recordedAt).toISOString() })), canDelete: canDeleteContact(a, ct), permissions: contactPermissionsFor(a, ct), canSendMail: contactPermissionsFor(a, ct).canSendMail, canEdit: edit(a, ct), canFollowup: contactPermissionsFor(a, ct).canFollowup, canAssign: assign(a, ct), mailAvailable: true, mailEvents: await contactMailEventsIn(c, input), mailEventLimit: CONTACT_MAIL_LIMITS.history });
}
async function listContactsIn(c, a, q, companyId) {
  const manager = contactManager(a), global3 = all(a), develop = a.capabilities.includes("leads.develop");
  if (!manager && !global3 && !develop)
    return failure("FORBIDDEN", "\u65E0\u8054\u7CFB\u4EBA\u67E5\u8BE2\u6743\u9650");
  const filter = `WHERE ct.crm_deleted_at IS NULL AND co.crm_deleted_at IS NULL ${companyId !== void 0 ? `AND co.id=${companyId}` : ""} AND ($1::boolean OR ($2::boolean AND c.origin='operations') OR ($3::boolean AND (${CONTACT_OWNER_SQL}=$4::uuid OR ${sharedAccessSql("$4::uuid", CONTACT_OWNER_SQL)})))
 AND (ct.email ILIKE $5 ESCAPE '!' OR ct.first_name ILIKE $5 ESCAPE '!' OR ct.last_name ILIKE $5 ESCAPE '!' OR ct.title ILIKE $5 ESCAPE '!' OR co.name ILIKE $5 ESCAPE '!' OR COALESCE(ct.extra->>'note','') ILIKE $5 ESCAPE '!')
 AND ($6::text IS NULL OR ct.stage=$6) AND ($7::text IS NULL OR ct.status=$7) AND ($8::text IS NULL OR ct.tags ? $8) AND ($9::text IS NULL OR COALESCE(CASE co.customer_type WHEN '\u4EE3\u7406' THEN 'agent' WHEN '\u76F4\u5BA2' THEN 'direct' END,ct.client_type)=$9) AND ($10::text IS NULL OR COALESCE(co.country,ct.country)=$10)
 AND ($11::text='all' OR ($11='personal' AND c.origin='personal' AND ${CONTACT_OWNER_SQL}=$4::uuid) OR ($11='assigned' AND c.origin='operations' AND (${CONTACT_OWNER_SQL}=$4::uuid OR ${sharedAccessSql("$4::uuid", CONTACT_OWNER_SQL)})))
 AND ($12::text IS NULL OR ($12='accepted' AND EXISTS(SELECT 1 FROM crm_contact_assignment_requests ar WHERE ar.contact_id=ct.id AND ar.status='accepted')) OR ($12='unassigned' AND ${CONTACT_OWNER_SQL} IS NULL AND NOT EXISTS(SELECT 1 FROM crm_contact_assignment_requests ar WHERE ar.contact_id=ct.id AND ar.status='pending')))
 AND (NOT $13::boolean OR ct.crm_touch_status IN ('contacted','replied','bounced','autoreply'))
 AND ($14::text IS NULL OR COALESCE((SELECT act.stage FROM crm_shared_activities act WHERE act.contact_id=ct.id AND act.customer_id=c.customer_id AND act.stage IS NOT NULL ORDER BY act.occurred_at DESC,act.id DESC LIMIT 1),CASE WHEN ct.crm_touch_status IN ('contacted','replied','bounced','autoreply') THEN 'reaching' ELSE 'cold' END)=$14)
 AND ($15::text IS NULL OR ct.crm_touch_status=$15) AND ($16::text IS NULL OR ct.language=$16)
 AND ($17::text IS NULL OR (CASE $17::text ${Object.entries(CONTACT_GROUP_SQL).map(([dimension, value2]) => `WHEN '${dimension}' THEN ${value2.key}`).join(" ")} END)=$18::text)`;
  const p = [global3, manager, develop, a.userId, `%${q.search.replace(/[!%_]/g, "!$&")}%`, q.stage ?? null, q.status ?? null, q.tags ?? null, q.clientType ?? null, q.country ?? null, q.scope ?? "all", q.assignment ?? null, q.followupOnly ?? false, q.crmStage ?? null, q.touchStatus ?? null, q.language ?? null, q.groupDimension ?? null, q.groupKey ?? null];
  const order = q.followupOnly ? "page.last_followup_at DESC NULLS LAST," : "";
  const count = await c.query(`SELECT count(*)::int AS n ${JOINS} ${filter}`, p), rows = await c.query(`WITH contact_page AS MATERIALIZED (
 SELECT ct.id AS contact_id,c.customer_id,ct.updated_at ${q.followupOnly ? `,${LAST_FOLLOWUP_AT} AS last_followup_at` : ""}
 ${JOINS} ${filter} ORDER BY ${q.followupOnly ? "last_followup_at DESC NULLS LAST," : ""}ct.updated_at DESC,ct.id DESC LIMIT $19 OFFSET $20
 ) SELECT ${PROJECTION} FROM contact_page page JOIN contacts ct ON ct.id=page.contact_id JOIN crm_customer_contacts cc ON cc.contact_id=page.contact_id AND cc.customer_id=page.customer_id JOIN crm_customers c ON c.customer_id=page.customer_id JOIN companies co ON co.id=c.company_id
 ORDER BY ${order}page.updated_at DESC,page.contact_id DESC`, [...p, q.limit, q.offset]);
  return success({ items: rows.rows.map((row2) => mapped2(a, row2)), total: count.rows[0].n });
}
var CONTACT_GROUP_SQL = {
  batch: { key: "COALESCE(NULLIF(ct.source_detail,''),NULLIF(ct.source_level1,''),NULLIF(ct.source_level2,''),'unset')", label: "CASE WHEN COALESCE(NULLIF(ct.source_detail,''),NULLIF(ct.source_level1,''),NULLIF(ct.source_level2,'')) IS NULL THEN '\u672A\u6807\u8BB0' ELSE COALESCE(NULLIF(ct.source_detail,''),NULLIF(ct.source_level1,''),NULLIF(ct.source_level2,'')) END" },
  country: { key: "COALESCE(NULLIF(co.country,''),NULLIF(ct.country,''),'unset')", label: "COALESCE(NULLIF(co.country,''),NULLIF(ct.country,''),'\u672A\u6807\u8BB0')" },
  company: { key: "co.id::text", label: "co.name" },
  clientType: { key: "COALESCE(CASE co.customer_type WHEN '\u4EE3\u7406' THEN 'agent' WHEN '\u76F4\u5BA2' THEN 'direct' END,ct.client_type,'unset')", label: "CASE COALESCE(CASE co.customer_type WHEN '\u4EE3\u7406' THEN 'agent' WHEN '\u76F4\u5BA2' THEN 'direct' END,ct.client_type) WHEN 'agent' THEN '\u4EE3\u7406' WHEN 'direct' THEN '\u76F4\u5BA2' ELSE '\u672A\u8BBE\u7F6E' END" }
};
async function listContactGroupsIn(c, a, q) {
  const manager = contactManager(a), global3 = all(a), develop = a.capabilities.includes("leads.develop");
  if (!manager && !global3 && !develop)
    return failure("FORBIDDEN", "\u65E0\u8054\u7CFB\u4EBA\u67E5\u8BE2\u6743\u9650");
  const expression = CONTACT_GROUP_SQL[q.dimension];
  const access2 = `WHERE ct.crm_deleted_at IS NULL AND co.crm_deleted_at IS NULL AND ($1::boolean OR ($2::boolean AND c.origin='operations') OR ($3::boolean AND (${CONTACT_OWNER_SQL}=$4::uuid OR ${sharedAccessSql("$4::uuid", CONTACT_OWNER_SQL)}))) AND ($5::text='all' OR ($5='personal' AND c.origin='personal' AND ${CONTACT_OWNER_SQL}=$4::uuid) OR ($5='assigned' AND c.origin='operations' AND (${CONTACT_OWNER_SQL}=$4::uuid OR ${sharedAccessSql("$4::uuid", CONTACT_OWNER_SQL)})))`;
  const rows = await c.query(`WITH grouped AS (
  SELECT ${expression.key} AS key,${expression.label} AS label,count(*)::int AS count,
   count(DISTINCT co.id)::int AS company_count,
   count(DISTINCT COALESCE(NULLIF(co.country,''),NULLIF(ct.country,'')))::int AS country_count,
   count(*) FILTER(WHERE ct.crm_touch_status IN ('contacted','replied','bounced','autoreply'))::int AS touched_count,
   bool_or(concat_ws(' ',ct.email,ct.first_name,ct.last_name,co.name,ct.title,ct.phone) ILIKE $6 ESCAPE '!') AS member_match,
   max(ct.created_at) AS latest_imported_at,
   max(ct.updated_at) AS latest_updated_at,
   (array_agg(DISTINCT co.name ORDER BY co.name) FILTER(WHERE co.name IS NOT NULL))[1:3] AS companies,
   (array_agg(DISTINCT COALESCE(NULLIF(co.country,''),NULLIF(ct.country,'')) ORDER BY COALESCE(NULLIF(co.country,''),NULLIF(ct.country,''))) FILTER(WHERE COALESCE(NULLIF(co.country,''),NULLIF(ct.country,'')) IS NOT NULL))[1:3] AS countries,
   (array_agg(DISTINCT NULLIF(ct.source_level1,'') ORDER BY NULLIF(ct.source_level1,'')) FILTER(WHERE NULLIF(ct.source_level1,'') IS NOT NULL))[1:3] AS source_level1,
   (array_agg(DISTINCT COALESCE(CASE co.customer_type WHEN '\u4EE3\u7406' THEN '\u4EE3\u7406' WHEN '\u76F4\u5BA2' THEN '\u76F4\u5BA2' END,ct.client_type,'\u672A\u8BBE\u7F6E') ORDER BY COALESCE(CASE co.customer_type WHEN '\u4EE3\u7406' THEN '\u4EE3\u7406' WHEN '\u76F4\u5BA2' THEN '\u76F4\u5BA2' END,ct.client_type,'\u672A\u8BBE\u7F6E')))[1:3] AS client_types
  ${JOINS} ${access2} GROUP BY 1,2
 ),filtered AS (SELECT * FROM grouped WHERE ($6::text='' OR label ILIKE $6 ESCAPE '!' OR member_match))
 SELECT *,count(*) OVER()::int AS total FROM filtered ORDER BY count DESC,label LIMIT $7 OFFSET $8`, [global3, manager, develop, a.userId, q.scope, q.search ? `%${q.search.replace(/[!%_]/g, "!$&")}%` : "", q.limit, q.offset]);
  return success({ items: rows.rows.map((row2) => ({ key: String(row2.key), label: String(row2.label), count: Number(row2.count), companyCount: Number(row2.company_count), countryCount: Number(row2.country_count), touchedCount: Number(row2.touched_count), companies: row2.companies ?? [], countries: row2.countries ?? [], clientTypes: row2.client_types ?? [], sourceLevel1: row2.source_level1 ?? [], latestImportedAt: row2.latest_imported_at ? new Date(row2.latest_imported_at).toISOString() : null, latestUpdatedAt: row2.latest_updated_at ? new Date(row2.latest_updated_at).toISOString() : null })), total: Number(rows.rows[0]?.total ?? 0) });
}
async function cached(c, a, operation, input, work, replay) {
  const digest = (0, import_node_crypto8.createHash)("sha256").update(JSON.stringify(input)).digest("hex"), old = (await c.query("SELECT digest,response FROM crm_lead_idempotency WHERE actor_id=$1 AND operation=$2 AND key=$3", [a.userId, operation, input.idempotencyKey])).rows[0];
  if (old)
    return old.digest !== digest ? failure("CONFLICT", "\u5E42\u7B49\u952E\u5DF2\u7528\u4E8E\u4E0D\u540C\u8BF7\u6C42") : replay ? replay(old.response) : success(old.response);
  const result2 = await work();
  if (result2.ok)
    await c.query("INSERT INTO crm_lead_idempotency(actor_id,operation,key,digest,response) VALUES($1,$2,$3,$4,$5)", [a.userId, operation, input.idempotencyKey, digest, JSON.stringify(result2.data)]);
  return result2;
}
async function members(c) {
  return (await c.query(`SELECT u.user_id,pa.scope,pa.capabilities,ARRAY(SELECT g.role FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active) AS roles FROM public.identity_users u JOIN public.identity_product_access pa ON pa.user_id=u.user_id AND pa.product_id='crm' AND pa.active WHERE u.active AND NOT u.must_change_password FOR SHARE OF u,pa`)).rows;
}
function validTarget(member, actorId) {
  return !!member && isContactAssignmentTarget({ userId: member.user_id, roles: member.roles, capabilities: effectiveCapabilitiesFor(member.roles, member.capabilities) }, actorId);
}
var REQUEST_SELECT = `SELECT r.request_id AS "requestId",COALESCE(gm.group_id,r.request_id) AS "groupId",r.contact_id AS "contactId",r.customer_id AS "customerId",r.version,COALESCE(NULLIF(concat_ws(' ',ct.first_name,ct.last_name),''),'\u8054\u7CFB\u4EBA') AS "contactName",NULL::text AS email,co.name AS "companyName",r.target_user_id AS "targetUserId",target.display_name AS "targetName",r.actor_id AS "actorId",actor.display_name AS "actorName",r.status,r.created_at AS "createdAt",r.decided_at AS "decidedAt",c.origin FROM crm_contact_assignment_requests r LEFT JOIN crm_contact_assignment_group_members gm ON gm.request_id=r.request_id JOIN contacts ct ON ct.id=r.contact_id JOIN crm_customers c ON c.customer_id=r.customer_id JOIN companies co ON co.id=c.company_id JOIN public.identity_users target ON target.user_id=r.target_user_id JOIN public.identity_users actor ON actor.user_id=r.actor_id`;
function mapRequest(a, r) {
  const { origin: _, ...item } = r;
  return { ...item, createdAt: new Date(r.createdAt).toISOString(), decidedAt: r.decidedAt ? new Date(r.decidedAt).toISOString() : null, canAccept: r.status === "pending" && r.targetUserId === a.userId && a.capabilities.includes("leads.develop"), canReject: r.status === "pending" && r.targetUserId === a.userId && a.capabilities.includes("leads.develop"), canCancel: r.status === "pending" && r.origin === "operations" && contactManager(a) };
}
async function request(c, a, id) {
  const row2 = (await c.query(`${REQUEST_SELECT} WHERE r.request_id=$1`, [id])).rows[0];
  if (!row2 || !([row2.actorId, row2.targetUserId].includes(a.userId) || row2.origin === "operations" && contactManager(a)))
    return failure("NOT_FOUND", "\u5206\u914D\u8BF7\u6C42\u4E0D\u5B58\u5728");
  return success(mapRequest(a, row2));
}
async function assignmentEvent(c, a, r, type, recipients2, activityId, groupCount) {
  await c.query("INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES($1,$2,'crm',$3,$4,$5,$6::uuid[])", [type, a.userId, r.version, r.customerId, JSON.stringify({ requestId: r.requestId, groupId: r.groupId, contactId: r.contactId, customerId: r.customerId, version: r.version, companyName: r.companyName, contactName: r.contactName, ...groupCount ? { groupCount } : {}, ...activityId ? { activityId } : {} }), [...new Set(recipients2)].sort()]);
}
async function contactAssignmentsIn(c, a, q) {
  const column = q.view === "incoming" ? "target_user_id" : "actor_id";
  if (q.view === "outgoing" && !contactManager(a))
    return failure("FORBIDDEN", "\u65E0\u5206\u914D\u7BA1\u7406\u6743\u9650");
  if (q.view === "incoming" && !a.capabilities.includes("leads.develop"))
    return failure("FORBIDDEN", "\u65E0\u5206\u914D\u63A5\u6536\u6743\u9650");
  if (q.requestId) {
    const rows2 = await c.query(`${REQUEST_SELECT} WHERE (r.${column}=$1 OR $3::boolean AND c.origin='operations') AND r.request_id=$2`, [a.userId, q.requestId, q.view === "outgoing" && contactManager(a)]);
    return success({ items: rows2.rows.map((r) => mapRequest(a, r)), total: rows2.rows.length });
  }
  if (q.groupId) {
    const migrated = await migrateContactAssignmentGroups(c);
    if (!migrated.ok)
      return migrated;
    const rows2 = await c.query(`${REQUEST_SELECT} WHERE COALESCE(gm.group_id,r.request_id)=$2 AND (r.${column}=$1 OR $3::boolean AND c.origin='operations') ORDER BY r.created_at,r.request_id`, [a.userId, q.groupId, q.view === "outgoing" && contactManager(a)]);
    return success({ items: rows2.rows.map((r) => mapRequest(a, r)), total: rows2.rows.length });
  }
  const filter = `WHERE ct.crm_deleted_at IS NULL AND (r.${column}=$1 OR $4::boolean AND c.origin='operations') AND r.status=$2 AND (co.name ILIKE $3 ESCAPE '!' OR ct.first_name ILIKE $3 ESCAPE '!' OR ct.last_name ILIKE $3 ESCAPE '!')`, p = [a.userId, q.status, `%${q.search.replace(/[!%_]/g, "!$&")}%`, q.view === "outgoing" && contactManager(a)];
  const rows = await c.query(`${REQUEST_SELECT} ${filter} ORDER BY r.created_at DESC,r.request_id DESC LIMIT $5 OFFSET $6`, [...p, q.limit, q.offset]), count = await c.query(`SELECT count(*)::int AS n FROM crm_contact_assignment_requests r JOIN contacts ct ON ct.id=r.contact_id JOIN crm_customers c ON c.customer_id=r.customer_id JOIN companies co ON co.id=c.company_id ${filter}`, p);
  return success({ items: rows.rows.map((r) => mapRequest(a, r)), total: count.rows[0].n });
}
async function contactAssignmentGroupsIn(c, a, q) {
  const migrated = await migrateContactAssignmentGroups(c);
  if (!migrated.ok)
    return migrated;
  const column = q.view === "incoming" ? "target_user_id" : "actor_id";
  if (q.view === "outgoing" && !contactManager(a))
    return failure("FORBIDDEN", "\u65E0\u5206\u914D\u7BA1\u7406\u6743\u9650");
  if (q.view === "incoming" && !a.capabilities.includes("leads.develop"))
    return failure("FORBIDDEN", "\u65E0\u5206\u914D\u63A5\u6536\u6743\u9650");
  const search = `%${q.search.replace(/[!%_]/g, "!$&")}%`, manager = q.view === "outgoing" && contactManager(a);
  const rows = await c.query(`WITH grouped AS (
  SELECT COALESCE(gm.group_id,r.request_id) AS group_id,count(*)::int AS total,
   count(*) FILTER(WHERE r.status='pending')::int AS pending,count(*) FILTER(WHERE r.status='accepted')::int AS accepted,
   count(*) FILTER(WHERE r.status='rejected')::int AS rejected,count(*) FILTER(WHERE r.status='cancelled')::int AS cancelled,
   min(actor.display_name) AS actor_name,min(target.display_name) AS target_name,min(r.created_at) AS created_at,
   (array_agg(COALESCE(NULLIF(concat_ws(' ',ct.first_name,ct.last_name),''),'\u8054\u7CFB\u4EBA') ORDER BY r.created_at,r.request_id))[1:5] AS contact_names,
   (array_agg(DISTINCT co.name ORDER BY co.name))[1:5] AS company_names
  FROM crm_contact_assignment_requests r LEFT JOIN crm_contact_assignment_group_members gm ON gm.request_id=r.request_id
  JOIN contacts ct ON ct.id=r.contact_id JOIN crm_customers c ON c.customer_id=r.customer_id JOIN companies co ON co.id=c.company_id
  JOIN public.identity_users actor ON actor.user_id=r.actor_id JOIN public.identity_users target ON target.user_id=r.target_user_id
  WHERE ct.crm_deleted_at IS NULL AND (r.${column}=$1 OR $4::boolean AND c.origin='operations')
  GROUP BY COALESCE(gm.group_id,r.request_id),r.target_user_id,r.actor_id
  HAVING bool_or(r.status=$2 AND (co.name ILIKE $3 ESCAPE '!' OR ct.first_name ILIKE $3 ESCAPE '!' OR ct.last_name ILIKE $3 ESCAPE '!'))
 ) SELECT *,count(*) OVER()::int AS group_total FROM grouped ORDER BY created_at DESC,group_id DESC LIMIT $5 OFFSET $6`, [a.userId, q.status, search, manager, q.limit, q.offset]);
  const items = rows.rows.map((row2) => {
    const pending = Number(row2.pending);
    return { groupId: String(row2.group_id), total: Number(row2.total), pending, accepted: Number(row2.accepted), rejected: Number(row2.rejected), cancelled: Number(row2.cancelled), actorName: String(row2.actor_name), targetName: String(row2.target_name), createdAt: new Date(row2.created_at).toISOString(), contactNames: row2.contact_names, companyNames: row2.company_names, canAcceptAll: pending > 0 && q.view === "incoming" && a.capabilities.includes("leads.develop"), canRejectAll: pending > 0 && q.view === "incoming" && a.capabilities.includes("leads.develop"), canCancelAll: pending > 0 && contactManager(a) };
  });
  return success({ items, total: Number(rows.rows[0]?.group_total ?? 0) });
}
async function createContactAssignmentsIn(c, a, input) {
  const migrated = await migrateContactAssignmentGroups(c);
  if (!migrated.ok)
    return migrated;
  if (!contactManager(a))
    return failure("FORBIDDEN", "\u65E0\u5206\u914D\u6743\u9650");
  const currentMembers = await members(c);
  if (!validTarget(currentMembers.find((m) => m.user_id === input.targetUserId), a.userId) || input.notifyUserIds.some((id) => !currentMembers.some((m) => m.user_id === id && m.roles.length)))
    return failure("INVALID_INPUT", "\u5206\u914D\u6210\u5458\u5DF2\u5931\u6548\u6216\u65E0\u7528\u6237\u5F00\u53D1\u6743\u9650");
  return cached(c, a, "contact-assignments:create", input, async () => {
    const items = [];
    const groupId = (0, import_node_crypto8.randomUUID)(), ordered = [...input.contacts].sort((x, y) => x.contactId - y.contactId);
    for (const [index, ref2] of ordered.entries()) {
      const ct = await contact(c, ref2, true);
      if (!ct || !read(a, ct))
        return failure("NOT_FOUND", "\u8054\u7CFB\u4EBA\u4E0D\u5B58\u5728");
      if (!assign(a, ct) || ct.contactVersion !== ref2.expectedVersion)
        return failure("CONFLICT", "\u8054\u7CFB\u4EBA\u5DF2\u5206\u914D\u3001\u53D7\u9650\u6216\u7248\u672C\u5DF2\u53D8\u5316");
      if ((await c.query("SELECT 1 FROM crm_contact_assignment_requests WHERE contact_id=$1 AND status IN ('pending','accepted')", [ref2.contactId])).rows.length)
        return failure("CONFLICT", "\u8054\u7CFB\u4EBA\u5DF2\u6709\u6709\u6548\u5206\u914D\u8BF7\u6C42");
      const id = (0, import_node_crypto8.randomUUID)();
      await c.query("INSERT INTO crm_contact_assignment_requests(request_id,contact_id,customer_id,target_user_id,actor_id,notify_user_ids) VALUES($1,$2,$3,$4,$5,$6::uuid[])", [id, ref2.contactId, ref2.customerId, input.targetUserId, a.userId, input.notifyUserIds]);
      await c.query("INSERT INTO crm_contact_assignment_group_members(group_id,request_id) VALUES($1,$2)", [groupId, id]);
      const r = await request(c, a, id);
      if (!r.ok)
        return r;
      items.push(r.data);
      if (index === 0)
        await assignmentEvent(c, a, r.data, CONTACT_ASSIGNMENT_EVENTS.requested, [a.userId, input.targetUserId, ...input.notifyUserIds], void 0, ordered.length);
    }
    return success({ items });
  }, async (old) => {
    const items = [];
    for (const r of old.items) {
      const current = await request(c, a, r.requestId);
      if (!current.ok)
        return current;
      items.push(current.data);
    }
    return success({ items });
  });
}
async function decideContactAssignmentIn(c, a, action, input) {
  const row2 = (await c.query("SELECT * FROM crm_contact_assignment_requests WHERE request_id=$1 FOR UPDATE", [input.requestId])).rows[0];
  if (!row2 || (action === "cancel" ? !contactManager(a) : row2.target_user_id !== a.userId || !a.capabilities.includes("leads.develop")))
    return failure("NOT_FOUND", "\u5206\u914D\u8BF7\u6C42\u4E0D\u5B58\u5728");
  return cached(c, a, `contact-assignment:${action}:${input.requestId}`, input, async () => {
    if (row2.status !== "pending" || row2.version !== input.expectedVersion)
      return failure("CONFLICT", "\u5206\u914D\u8BF7\u6C42\u72B6\u6001\u5DF2\u53D8\u5316");
    const ref2 = { contactId: row2.contact_id, customerId: row2.customer_id }, ct = await contact(c, ref2, true);
    if (!ct || action === "cancel" && ct.origin !== "operations")
      return failure("NOT_FOUND", "\u8054\u7CFB\u4EBA\u4E0D\u5B58\u5728");
    if (action === "accept") {
      const recipients2 = await members(c);
      if (!validTarget(recipients2.find((m) => m.user_id === a.userId), row2.actor_id))
        return failure("FORBIDDEN", "\u63A5\u6536\u6743\u9650\u5DF2\u53D8\u5316");
      if (ct.development_restriction?.trim() || ct.ownerUserId !== null)
        return failure("CONFLICT", "\u8054\u7CFB\u4EBA\u5F00\u53D1\u9650\u5236\u6216\u5F52\u5C5E\u5DF2\u53D8\u5316");
      await c.query("UPDATE contacts SET crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1", [ct.contactId]);
    }
    const status = action === "accept" ? "accepted" : action === "reject" ? "rejected" : "cancelled";
    await c.query("UPDATE crm_contact_assignment_requests SET status=$2,version=version+1,decided_at=now() WHERE request_id=$1", [input.requestId, status]);
    const result2 = await request(c, a, input.requestId);
    if (!result2.ok)
      return result2;
    await assignmentEvent(c, a, result2.data, CONTACT_ASSIGNMENT_EVENTS[status], [row2.actor_id, row2.target_user_id, ...row2.notify_user_ids]);
    return result2;
  }, () => request(c, a, input.requestId));
}
async function decideContactAssignmentGroupIn(c, a, action, input) {
  const migrated = await migrateContactAssignmentGroups(c);
  if (!migrated.ok)
    return migrated;
  const rows = (await c.query(`SELECT r.request_id,r.version,r.status,r.target_user_id,c.origin FROM crm_contact_assignment_requests r LEFT JOIN crm_contact_assignment_group_members gm ON gm.request_id=r.request_id JOIN crm_customers c ON c.customer_id=r.customer_id WHERE COALESCE(gm.group_id,r.request_id)=$1 ORDER BY r.request_id FOR UPDATE OF r`, [input.groupId])).rows;
  if (!rows.length)
    return failure("NOT_FOUND", "\u5206\u914D\u7EC4\u4E0D\u5B58\u5728");
  if (action === "cancel" ? !contactManager(a) : rows.some((row2) => row2.target_user_id !== a.userId) || !a.capabilities.includes("leads.develop"))
    return failure("NOT_FOUND", "\u5206\u914D\u8BF7\u6C42\u4E0D\u5B58\u5728");
  for (const row2 of rows.filter((row3) => row3.status === "pending")) {
    const decision = { requestId: row2.request_id, expectedVersion: Number(row2.version), idempotencyKey: (0, import_node_crypto8.createHash)("sha256").update(`${input.idempotencyKey}:${row2.request_id}`).digest("hex") };
    const result3 = await decideContactAssignmentIn(c, a, action, decision);
    if (!result3.ok)
      return result3;
  }
  const result2 = await contactAssignmentsIn(c, a, { view: action === "cancel" ? "outgoing" : "incoming", status: "pending", search: "", limit: 200, offset: 0, groupId: input.groupId });
  return result2.ok ? success({ items: result2.data.items }) : result2;
}
async function contactUpdateIn(c, a, input) {
  const ct = await contact(c, input, true);
  if (!ct || !read(a, ct))
    return failure("NOT_FOUND", "\u8054\u7CFB\u4EBA\u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u4FEE\u6539");
  if ("clientType" in input.fields)
    return failure("INVALID_INPUT", "\u5BA2\u6237\u7C7B\u578B\u5C5E\u4E8E\u516C\u53F8\u8D44\u6599\uFF0C\u8BF7\u4FEE\u6539\u516C\u53F8\u5BA2\u6237\u7C7B\u578B");
  if (Object.keys(input.fields).some((f) => !contactPermissionsFor(a, ct).editableFields.includes(f)))
    return failure("FORBIDDEN", "\u6CA1\u6709\u6240\u9009\u5B57\u6BB5\u7684\u4FEE\u6539\u6743\u9650");
  return cached(c, a, `contact-update:${input.contactId}`, input, async () => {
    if (ct.contactVersion !== input.expectedVersion)
      return failure("CONFLICT", "\u8054\u7CFB\u4EBA\u7248\u672C\u5DF2\u53D8\u5316");
    const fields = { email: "email", firstName: "first_name", lastName: "last_name", title: "title", phone: "phone", whatsapp: "whatsapp", sourceLevel1: "source_level1", sourceLevel2: "source_level2", linkedinUrl: "linkedin", country: "country", clientType: "client_type", language: "language", stage: "stage", status: "status", tags: "tags", preferences: "extra" };
    const values = [input.contactId];
    const sets = [];
    for (const [key, value2] of Object.entries(input.fields)) {
      if (!Object.hasOwn(fields, key))
        return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u5B57\u6BB5\u4E0D\u53EF\u4FEE\u6539");
      const json = key === "tags" || key === "preferences";
      values.push(json ? JSON.stringify(value2) : key === "email" ? typeof value2 === "string" ? value2.trim().toLowerCase() || null : null : value2);
      sets.push(key === "preferences" ? `extra=jsonb_set(COALESCE(extra,'{}'::jsonb),'{preferences}',$${values.length}::jsonb,true)` : `${fields[key]}=$${values.length}${json ? "::jsonb" : ""}`);
    }
    await c.query(`UPDATE contacts SET ${sets.join(",")},crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1`, values);
    await contactEvent(c, a, ct, CONTACT_ASSIGNMENT_EVENTS.updated, input.expectedVersion + 1);
    return contactDetailIn(c, a, input);
  }, () => contactDetailIn(c, a, input));
}
async function contactEvent(c, a, ct, type, version3, activityId, mailEventId) {
  await c.query("INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES($1,$2,'crm',$3,$4,$5,$6::uuid[])", [type, a.userId, version3, ct.customerId, JSON.stringify({ contactId: ct.contactId, customerId: ct.customerId, version: version3, ...activityId ? { activityId } : {}, ...mailEventId ? { mailEventId } : {} }), [.../* @__PURE__ */ new Set([a.userId, ct.created_by, ...ct.ownerUserId ? [ct.ownerUserId] : [], ...(ct.shared_grants ?? []).map((g) => g.targetUserId)])].sort()]);
}
async function contactFollowupIn(c, a, input) {
  const ct = await contact(c, input, true);
  if (!ct || !read(a, ct))
    return failure("NOT_FOUND", "\u8054\u7CFB\u4EBA\u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u8DDF\u8FDB");
  const permissions = contactPermissionsFor(a, ct);
  if (input.stage !== void 0 && !permissions.canChangeStage || (input.stage === void 0 || input.method !== "note" || input.contactStatus !== void 0) && !permissions.canFollowup)
    return failure("FORBIDDEN", "\u6CA1\u6709\u8DDF\u8FDB\u6216\u5173\u7CFB\u9636\u6BB5\u4FEE\u6539\u6743\u9650");
  return cached(c, a, `contact-followup:${input.contactId}`, input, async () => {
    if (ct.contactVersion !== input.expectedVersion)
      return failure("CONFLICT", "\u8054\u7CFB\u4EBA\u7248\u672C\u5DF2\u53D8\u5316");
    const recorded = (await c.query("SELECT clock_timestamp() AS t")).rows[0].t, occurred = input.occurredAt ? new Date(input.occurredAt) : recorded, method = input.method ?? "other";
    if (!Number.isFinite(occurred.getTime()) || occurred.getTime() > recorded.getTime() + FOLLOWUP_TIME_LIMITS.future_skew_seconds * MILLISECONDS_PER_SECOND7 || method === "note" && input.contactStatus !== void 0)
      return failure("INVALID_INPUT", "\u8DDF\u8FDB\u65F6\u95F4\u6216\u89E6\u8FBE\u72B6\u6001\u65E0\u6548");
    const note = !permissions.canFollowup && input.stage !== void 0 ? `\u5173\u7CFB\u9636\u6BB5\uFF1A${input.stage}` : input.note;
    const activity = (await c.query("INSERT INTO crm_shared_activities(customer_id,interaction_id,actor_id,note,stage,method,occurred_at,recorded_at,created_at,contact_id,contact_status) VALUES($1,NULL,$2,$3,$4,$5,$6,$7,$7,$8,$9) RETURNING id::text", [ct.customerId, a.userId, note, input.stage ?? null, method, occurred, recorded, ct.contactId, input.contactStatus ?? null])).rows[0];
    const legacyStatus = input.contactStatus !== void 0 ? FOLLOWUP_LEGACY_STATUS[input.contactStatus] : null;
    await c.query("UPDATE contacts SET crm_touch_status=COALESCE($2,crm_touch_status),status=COALESCE($3,status),crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1", [ct.contactId, input.contactStatus ?? null, legacyStatus]);
    await refreshMailProjectionIn(c, input, ct.email);
    await contactEvent(c, a, ct, CONTACT_ASSIGNMENT_EVENTS.followup, input.expectedVersion + 1, activity.id);
    return contactDetailIn(c, a, input);
  }, () => contactDetailIn(c, a, input));
}
async function companyEditable(c, a, ct) {
  if (all(a))
    return true;
  if (!a.capabilities.includes("leads.develop") || !(ownManager(a, ct) || ct.origin === "personal" && ct.ownerUserId === a.userId))
    return false;
  const restricted = ownManager(a, ct) ? await c.query("SELECT 1 FROM crm_customers WHERE company_id=$1 AND origin='personal' LIMIT 1", [ct.companyId]) : await c.query("SELECT 1 FROM crm_customers WHERE company_id=$1 AND created_by<>$2 LIMIT 1", [ct.companyId, a.userId]);
  return !restricted.rowCount;
}
async function companyUpdateIn(c, a, input) {
  const ct = await contact(c, input, true);
  if (!ct || !read(a, ct) || !await companyEditable(c, a, ct))
    return failure("FORBIDDEN", "\u6CA1\u6709\u516C\u53F8\u8D44\u6599\u4FEE\u6539\u6743\u9650");
  return cached(c, a, `company-update:${ct.companyId}`, input, async () => {
    const company = (await c.query("SELECT updated_at::text AS revision FROM companies WHERE id=$1 FOR UPDATE", [ct.companyId])).rows[0];
    if (company.revision !== input.expectedRevision)
      return failure("CONFLICT", "\u516C\u53F8\u8D44\u6599\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5");
    const columns = { name: "name", customerType: "customer_type", domain: "domain", country: "country", industry: "industry", size: "size", backcheckData: "backcheck_data" };
    const values = [ct.companyId];
    const sets = [];
    for (const [key, value2] of Object.entries(input.fields)) {
      if (!Object.hasOwn(columns, key))
        return failure("INVALID_INPUT", "\u516C\u53F8\u5B57\u6BB5\u4E0D\u53EF\u4FEE\u6539");
      values.push(key === "backcheckData" && value2 !== null ? JSON.stringify(value2) : value2);
      sets.push(`${columns[key]}=$${values.length}${key === "backcheckData" ? "::jsonb" : ""}`);
    }
    await c.query(`UPDATE companies SET ${sets.join(",")},updated_at=clock_timestamp() WHERE id=$1`, values);
    await contactEvent(c, a, ct, CONTACT_ASSIGNMENT_EVENTS.updated, ct.contactVersion ?? ct.customerVersion);
    return contactDetailIn(c, a, input);
  }, () => contactDetailIn(c, a, input));
}

// server/adapters/postgres/flat-lead-import.ts
var optional = (value2) => value2?.trim() || null;
async function importFlatLeadsIn(c, actor, input) {
  const personal = input.kind === "personal";
  const batchId = (0, import_node_crypto9.randomUUID)();
  await c.query("INSERT INTO crm_import_batches(batch_id,actor_id,source,source_detail,mapping) VALUES($1,$2,$3,$4,$5)", [batchId, actor.userId, input.source, input.sourceDetail, JSON.stringify(input.mapping ?? {})]);
  const rows = [];
  for (const [index, original] of input.rows.entries()) {
    const row2 = {
      ...original,
      customerKey: original.customerKey.trim(),
      companyName: original.companyName.trim(),
      email: original.email.trim().toLowerCase(),
      remark: unmatchedImportRemark(original.rawRow, Object.values(input.mapping ?? {}))
    };
    const extra = JSON.stringify(row2.remark ? { note: row2.remark } : {});
    const rowId = (0, import_node_crypto9.randomUUID)();
    let status = "created";
    let message = importRowIssue(row2);
    let customerId;
    if (message)
      status = "invalid";
    else {
      const existing = await c.query("SELECT * FROM crm_customers WHERE source=$1 AND customer_key=$2 FOR UPDATE", [input.source, row2.customerKey]);
      let parent = existing.rows[0];
      if (!parent && input.companyMatching) {
        const matches = await c.query(`SELECT cu.* FROM crm_customers cu JOIN companies co ON co.id=cu.company_id
          WHERE lower(btrim(co.name))=lower(btrim($1)) AND co.crm_deleted_at IS NULL
          AND cu.origin=$2 AND ($3::boolean AND cu.owner_user_id=$4::uuid OR NOT $3::boolean AND cu.owner_user_id IS NULL AND cu.state IN ('draft','published'))
          ORDER BY cu.customer_id FOR UPDATE OF cu`, [row2.companyName, input.kind, personal, actor.userId]);
        if (matches.rows.length > 1) {
          status = "restricted_conflict";
          message = "\u5B58\u5728\u591A\u6761\u540C\u540D\u516C\u53F8\uFF0C\u8BF7\u6838\u5BF9\u516C\u53F8\u8D44\u6599";
        } else
          parent = matches.rows[0];
      }
      const contact2 = row2.email ? await c.query("SELECT ct.*,cc.customer_id FROM contacts ct LEFT JOIN crm_customer_contacts cc ON cc.contact_id=ct.id WHERE ct.email=$1", [row2.email]) : { rows: [] };
      const activeContact = contact2.rows.find((item) => item.crm_deleted_at === null);
      const deletedContact = contact2.rows.find((item) => item.crm_deleted_at !== null);
      if (activeContact && (!parent || activeContact.customer_id !== parent.customer_id))
        status = "restricted_conflict";
      const restorableDeleted = deletedContact ? await contact(c, { contactId: deletedContact.id, customerId: deletedContact.customer_id }, true, true) : void 0;
      if (deletedContact && (!restorableDeleted || !canDeleteContact(actor, restorableDeleted))) {
        status = "restricted_conflict";
        message = "\u8BE5\u90AE\u7BB1\u5C5E\u4E8E\u5DF2\u5220\u9664\u8054\u7CFB\u4EBA\uFF0C\u8BF7\u4F7F\u7528\u539F\u516C\u53F8\u8D44\u6599\u6062\u590D";
      }
      if (deletedContact && restorableDeleted && canDeleteContact(actor, restorableDeleted) && !parent) {
        parent = (await c.query("SELECT * FROM crm_customers WHERE customer_id=$1 FOR UPDATE", [deletedContact.customer_id])).rows[0];
        if (parent)
          row2.companyName = restorableDeleted.companyName;
      }
      if (parent && (parent.origin !== input.kind || (personal ? parent.owner_user_id !== actor.userId || parent.state !== "owned" : parent.owner_user_id !== null || !["draft", ...input.companyMatching ? ["published"] : []].includes(parent.state))))
        status = "restricted_conflict";
      if (deletedContact && parent && parent.customer_id !== deletedContact.customer_id) {
        status = "restricted_conflict";
        message = "\u8BE5\u90AE\u7BB1\u5C5E\u4E8E\u5DF2\u5220\u9664\u8054\u7CFB\u4EBA\uFF0C\u8BF7\u4F7F\u7528\u539F\u516C\u53F8\u8D44\u6599\u6062\u590D";
      }
      if (status === "created") {
        let companyId = parent?.company_id;
        const companies = await c.query(`SELECT co.* FROM companies co WHERE co.crm_deleted_at IS NULL AND
          ${companyId ? "co.id=$1" : `lower(btrim(co.name))=lower(btrim($1)) AND (
            co.crm_created_by=$2::uuid AND NOT EXISTS(SELECT 1 FROM crm_customers cu WHERE cu.company_id=co.id) AND NOT EXISTS(SELECT 1 FROM contacts ct WHERE ct.company_id=co.id)
            OR EXISTS(SELECT 1 FROM crm_customers cu WHERE cu.company_id=co.id AND cu.origin=$3 AND ($4::boolean AND cu.owner_user_id=$2::uuid OR NOT $4::boolean)))`}
          ORDER BY co.id FOR UPDATE`, companyId ? [companyId] : [row2.companyName, actor.userId, input.kind, personal]);
        const company = companies.rows[0];
        const fields = { country: optional(row2.country), customer_type: optional(row2.customerType), industry: optional(row2.businessType), domain: optional(row2.website) };
        const conflict = company && Object.entries(fields).find(([key, value2]) => value2 && company[key] && company[key] !== value2);
        if (parent && !company || company && company.name.trim().toLowerCase() !== row2.companyName.toLowerCase() || conflict || companies.rows.length > 1) {
          status = "restricted_conflict";
          message = "\u540C\u4E00\u516C\u53F8\u7684\u56FD\u5BB6\u3001\u5BA2\u6237\u7C7B\u578B\u3001\u4E1A\u52A1\u7C7B\u578B\u6216\u7F51\u7AD9\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u6838\u5BF9";
        } else {
          if (company) {
            companyId = company.id;
            await c.query("UPDATE companies SET country=COALESCE(NULLIF(btrim(country),''),$2),customer_type=COALESCE(customer_type,$3),industry=COALESCE(NULLIF(btrim(industry),''),$4),domain=COALESCE(NULLIF(btrim(domain),''),$5),updated_at=now() WHERE id=$1", [companyId, ...Object.values(fields)]);
          } else {
            companyId = (await c.query("INSERT INTO companies(name,country,customer_type,industry,domain) VALUES($1,$2,$3,$4,$5) RETURNING id", [row2.companyName, ...Object.values(fields)])).rows[0].id;
          }
          customerId = parent?.customer_id ?? (0, import_node_crypto9.randomUUID)();
          const newCustomer = !parent;
          if (!parent) {
            await c.query("INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin,state,owner_user_id,business_type) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [customerId, companyId, input.source, row2.customerKey, input.sourceDetail, actor.userId, input.kind, personal ? "owned" : "draft", personal ? actor.userId : null, optional(row2.businessType)]);
          }
          const values = [optional(row2.firstName ?? row2.name), optional(row2.lastName), optional(row2.title), optional(row2.phone), optional(row2.whatsapp), optional(row2.linkedinUrl), optional(row2.sourceLevel1), optional(row2.sourceLevel2)];
          const identical = !row2.email && await c.query(`SELECT ct.id FROM contacts ct JOIN crm_customer_contacts cc ON cc.contact_id=ct.id
            WHERE cc.customer_id=$1 AND ct.email IS NULL AND ct.crm_deleted_at IS NULL
            AND ct.first_name IS NOT DISTINCT FROM $2 AND ct.last_name IS NOT DISTINCT FROM $3 AND ct.title IS NOT DISTINCT FROM $4
            AND ct.phone IS NOT DISTINCT FROM $5 AND ct.whatsapp IS NOT DISTINCT FROM $6 AND ct.linkedin IS NOT DISTINCT FROM $7
            AND ct.source_level1 IS NOT DISTINCT FROM $8 AND ct.source_level2 IS NOT DISTINCT FROM $9`, [customerId, ...values]);
          if (activeContact || identical && identical.rows.length)
            status = "duplicate";
          else {
            let contactId;
            let contactVersion;
            if (deletedContact) {
              if (!restorableDeleted) {
                status = "restricted_conflict";
                message = "\u8BE5\u90AE\u7BB1\u5C5E\u4E8E\u5DF2\u5220\u9664\u8054\u7CFB\u4EBA\uFF0C\u8BF7\u4F7F\u7528\u539F\u516C\u53F8\u8D44\u6599\u6062\u590D";
              } else {
                const restored = await c.query(`UPDATE contacts SET company_id=$2,
                  first_name=COALESCE($3,first_name),last_name=COALESCE($4,last_name),title=COALESCE($5,title),
                  phone=COALESCE($6,phone),whatsapp=COALESCE($7,whatsapp),linkedin=COALESCE($8,linkedin),
                  source_level1=COALESCE($9,source_level1),source_level2=COALESCE($10,source_level2),country=COALESCE($11,country),
                  language=COALESCE($12,language),client_type=COALESCE($13,client_type),stage=COALESCE($14,stage),status=COALESCE($15,status),
                  tags=CASE WHEN $16::jsonb='[]'::jsonb THEN tags ELSE $16::jsonb END,
                  extra=CASE WHEN $17::jsonb='{}'::jsonb THEN extra ELSE COALESCE(extra,'{}'::jsonb)||$17::jsonb END,
                  crm_deleted_at=NULL,crm_deleted_by=NULL,crm_contact_version=crm_contact_version+1,updated_at=clock_timestamp()
                  WHERE id=$1 AND crm_deleted_at IS NOT NULL RETURNING crm_contact_version`, [deletedContact.id, companyId, ...values, optional(row2.country), optional(row2.language), optional(row2.clientType), optional(row2.stage), optional(row2.status), JSON.stringify(row2.tags ?? []), extra]);
                if (!restored.rows.length) {
                  status = "restricted_conflict";
                  message = "\u8054\u7CFB\u4EBA\u6062\u590D\u72B6\u6001\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5";
                } else {
                  contactId = deletedContact.id;
                  contactVersion = restored.rows[0].crm_contact_version;
                  await c.query("INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2) ON CONFLICT(contact_id) DO NOTHING", [customerId, contactId]);
                }
              }
            } else {
              const created = await c.query("INSERT INTO contacts(email,company_id,first_name,last_name,title,phone,whatsapp,linkedin,source_level1,source_level2,country,language,client_type,stage,status,tags,extra,source,source_detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19) RETURNING id,crm_contact_version", [row2.email || null, companyId, ...values, optional(row2.country), optional(row2.language), optional(row2.clientType), row2.stage ?? "cold", row2.status ?? "", JSON.stringify(row2.tags ?? []), extra, input.source, input.sourceDetail]);
              contactId = created.rows[0].id;
              contactVersion = created.rows[0].crm_contact_version;
              await c.query("INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)", [customerId, contactId]);
            }
            if (status === "created") {
              const version3 = (await c.query("SELECT version FROM crm_customers WHERE customer_id=$1", [customerId])).rows[0].version;
              if (!contactId || !contactVersion) {
                status = "restricted_conflict";
                message = "\u8054\u7CFB\u4EBA\u6062\u590D\u7ED3\u679C\u4E0D\u5B8C\u6574\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5";
              } else {
                await c.query("INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload) VALUES($1,$2,$3,$4,$5,$6)", [newCustomer ? "crm.customer.created" : deletedContact ? "crm.contact.updated" : "crm.customer.updated", actor.userId, "crm", deletedContact ? contactVersion : version3, customerId, JSON.stringify({ customerId, ...deletedContact ? { contactId, version: contactVersion } : { version: version3 }, companyName: row2.companyName })]);
              }
            }
          }
        }
      }
    }
    await c.query("INSERT INTO crm_import_rows(row_id,batch_id,row_index,customer_key,raw_row,customer_id,status) VALUES($1,$2,$3,$4,$5,$6,$7)", [rowId, batchId, index, row2.customerKey, JSON.stringify({ input: row2, rawRow: row2.rawRow ?? original }), customerId ?? null, status]);
    rows.push({ rowId, index, status, ...customerId ? { customerId } : {}, ...message ? { message } : status === "restricted_conflict" ? { message: "\u9700\u6838\u5B9E\u6765\u6E90\u6216\u5BA2\u6237\u5F52\u5C5E" } : {} });
  }
  return { batchId, version: 1, rows };
}

// server/adapters/postgres/send-acceptance-schema.ts
var SEND_ACCEPTANCE_VERSION = "025-send-acceptance-public";
var SEND_ACCEPTANCE_SQL = `
ALTER TABLE crm_contact_mail_events ADD COLUMN archive_only boolean NOT NULL DEFAULT false;
CREATE TABLE crm_send_authorizations (
  authorization_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  send_key text NOT NULL CHECK(length(send_key) BETWEEN 1 AND ${SEND_AUTHORIZATION_LIMITS.sendKey}),
  contact_id integer NOT NULL REFERENCES contacts(id),
  customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
  recipient_email text NOT NULL, from_email text NOT NULL, subject text NOT NULL,
  authorized_recipients jsonb NOT NULL CHECK(jsonb_typeof(authorized_recipients)='array'),
  authorized_cc jsonb NOT NULL CHECK(jsonb_typeof(authorized_cc)='array'),
  request_fingerprint text NOT NULL,
  owner_user_id uuid REFERENCES public.identity_users(user_id),
  allow_advance_stage boolean NOT NULL,
  issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
  consumed_event_id uuid UNIQUE REFERENCES crm_contact_mail_events(event_id),
  consumed_fingerprint text, archived_after_revocation boolean,
  CHECK(expires_at>issued_at),
  CHECK((consumed_event_id IS NULL AND consumed_fingerprint IS NULL AND archived_after_revocation IS NULL)
    OR (consumed_event_id IS NOT NULL AND consumed_fingerprint IS NOT NULL AND archived_after_revocation IS NOT NULL)),
  UNIQUE(actor_id,send_key,contact_id,customer_id),
  FOREIGN KEY(customer_id,contact_id) REFERENCES crm_customer_contacts(customer_id,contact_id)
);
`;

// server/adapters/postgres/send-acceptance-repository.ts
var import_node_crypto10 = require("node:crypto");
var MILLISECONDS_PER_SECOND8 = 1e3;
var normalized = (emails) => [...new Set(emails.map((email3) => email3.toLowerCase()))].sort();
var fingerprint = (value2) => (0, import_node_crypto10.createHash)("sha256").update(JSON.stringify(value2)).digest("hex");
function mapped3(row2) {
  return {
    authorizationId: row2.authorization_id,
    contactId: row2.contact_id,
    customerId: row2.customer_id,
    recipientEmail: row2.recipient_email,
    fromEmail: row2.from_email,
    subject: row2.subject,
    issuedAt: new Date(row2.issued_at).toISOString(),
    expiresAt: new Date(row2.expires_at).toISOString()
  };
}
async function authorizeSendIn(client, actor, input) {
  const targets = [...input.recipients].sort((a, b) => a.contactId - b.contactId || a.customerId.localeCompare(b.customerId));
  const cc = normalized(input.ccEmails ?? []);
  const requestFingerprint = fingerprint([input.fromEmail.toLowerCase(), input.subject, targets.map((target) => [target.contactId, target.customerId, target.email.toLowerCase()]), cc]);
  const owners = [];
  for (const target of targets) {
    const contact2 = await contact(client, target, true);
    if (!contact2 || !read(actor, contact2) || !contactPermissionsFor(actor, contact2).canSendMail)
      return failure("NOT_FOUND", "\u8054\u7CFB\u4EBA\u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u53D1\u9001");
    if (contact2.email?.toLowerCase() !== target.email.toLowerCase() || input.fromEmail.toLowerCase() === target.email.toLowerCase())
      return failure("CONFLICT", "\u8054\u7CFB\u4EBA\u90AE\u7BB1\u5DF2\u53D8\u5316");
    owners.push(contact2.ownerUserId);
  }
  const old = await client.query("SELECT * FROM crm_send_authorizations WHERE actor_id=$1 AND send_key=$2 ORDER BY contact_id,customer_id FOR UPDATE", [actor.userId, input.sendKey]);
  const now = (await client.query("SELECT clock_timestamp() AS stamp")).rows[0].stamp;
  if (old.rowCount) {
    if (old.rows.length !== targets.length || old.rows.some((row2, index) => row2.request_fingerprint !== requestFingerprint || row2.consumed_event_id || row2.owner_user_id !== owners[index] || new Date(row2.expires_at) <= now))
      return failure("CONFLICT", "\u53D1\u9001\u7F16\u53F7\u5DF2\u4F7F\u7528\u6216\u5DF2\u8FC7\u671F");
    return success(old.rows.map(mapped3));
  }
  const expires = new Date(now.getTime() + SEND_AUTHORIZATION_LIMITS.attempt_seconds * MILLISECONDS_PER_SECOND8);
  const allowed = normalized(targets.map((target) => target.email));
  const result2 = [];
  for (const [index, target] of targets.entries()) {
    const inserted = await client.query(
      `INSERT INTO crm_send_authorizations(actor_id,send_key,contact_id,customer_id,recipient_email,from_email,subject,authorized_recipients,authorized_cc,request_fingerprint,owner_user_id,allow_advance_stage,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,true,$12,$13) RETURNING *`,
      [actor.userId, input.sendKey, target.contactId, target.customerId, target.email.toLowerCase(), input.fromEmail.toLowerCase(), input.subject, JSON.stringify(allowed), JSON.stringify(cc), requestFingerprint, owners[index], now, expires]
    );
    result2.push(mapped3(inserted.rows[0]));
  }
  return success(result2);
}
async function acceptSendIn(client, actor, input) {
  const event3 = input.event;
  if (event3.kind !== "sent" || event3.direction !== "outbound" || event3.correction)
    return failure("INVALID_INPUT", "\u4EC5\u5141\u8BB8\u5DF2\u63A5\u53D7\u7684\u53D1\u9001\u4E8B\u5B9E");
  if (input.observedEvent) {
    const observed = input.observedEvent;
    if (observed.contactId !== event3.contactId || observed.customerId !== event3.customerId || observed.eventKey !== event3.eventKey || observed.mailboxKey !== event3.mailboxKey || observed.messageKey !== event3.messageKey || observed.fromEmail.toLowerCase() !== event3.fromEmail.toLowerCase() || observed.subject !== event3.subject || observed.kind !== "sent" || observed.direction !== "outbound" || observed.correction)
      return failure("CONFLICT", "\u539F\u90AE\u4EF6\u8BC1\u636E\u4E0D\u5C5E\u4E8E\u540C\u4E00\u53D1\u9001");
  }
  const grant2 = (await client.query("SELECT * FROM crm_send_authorizations WHERE authorization_id=$1 AND actor_id=$2 FOR UPDATE", [input.authorizationId, actor.userId])).rows[0];
  if (!grant2)
    return failure("NOT_FOUND", "\u53D1\u9001\u6388\u6743\u4E0D\u5B58\u5728");
  const receiptFingerprint = fingerprint([contactMailFingerprint(event3), event3.advanceSendStage ?? false, input.observedEvent ? contactMailFingerprint(input.observedEvent) : null]);
  if (grant2.consumed_event_id) {
    if (grant2.consumed_fingerprint !== receiptFingerprint)
      return failure("CONFLICT", "\u53D1\u9001\u6388\u6743\u5DF2\u88AB\u5176\u4ED6\u56DE\u6267\u6D88\u8D39");
    return success({ eventId: grant2.consumed_event_id, duplicate: true, archivedAfterRevocation: grant2.archived_after_revocation });
  }
  const to = normalized(event3.toEmails), cc = normalized(event3.ccEmails);
  const occurred = new Date(event3.occurredAt).getTime(), skew = SEND_AUTHORIZATION_LIMITS.clock_skew_seconds * MILLISECONDS_PER_SECOND8;
  const now = (await client.query("SELECT clock_timestamp() AS stamp")).rows[0].stamp;
  if (!Number.isFinite(occurred) || occurred > now.getTime() + FOLLOWUP_TIME_LIMITS.future_skew_seconds * MILLISECONDS_PER_SECOND8)
    return failure("INVALID_INPUT", "\u90AE\u4EF6\u53D1\u751F\u65F6\u95F4\u65E0\u6548\u6216\u5C1A\u672A\u53D1\u751F");
  if (event3.contactId !== grant2.contact_id || event3.customerId !== grant2.customer_id || event3.subject !== grant2.subject || event3.fromEmail.toLowerCase() !== grant2.from_email || !to.includes(grant2.recipient_email) || to.some((email3) => !grant2.authorized_recipients.includes(email3)) || JSON.stringify(cc) !== JSON.stringify(grant2.authorized_cc) || event3.advanceSendStage && !grant2.allow_advance_stage || !Number.isFinite(occurred) || occurred < new Date(grant2.issued_at).getTime() - skew || occurred > new Date(grant2.expires_at).getTime() + skew)
    return failure("CONFLICT", "\u53D1\u9001\u56DE\u6267\u4E0E\u6388\u6743\u4E0D\u4E00\u81F4");
  const old = (await client.query("SELECT event_id,digest FROM crm_contact_mail_events WHERE actor_id=$1 AND event_key=$2 FOR UPDATE", [actor.userId, event3.eventKey])).rows[0];
  let storedEvent = event3;
  if (old) {
    if ((await client.query("SELECT 1 FROM crm_send_authorizations WHERE consumed_event_id=$1", [old.event_id])).rowCount)
      return failure("CONFLICT", "\u90AE\u4EF6\u4E8B\u5B9E\u5DF2\u5C5E\u4E8E\u5176\u4ED6\u56DE\u6267");
    if (old.digest !== contactMailFingerprint(event3)) {
      const observed = input.observedEvent;
      if (!observed || old.digest !== contactMailFingerprint(observed))
        return failure("CONFLICT", "\u539F\u90AE\u4EF6\u8BC1\u636E\u4E0E\u53D1\u9001\u56DE\u6267\u4E0D\u4E00\u81F4");
      storedEvent = { ...observed, advanceSendStage: event3.advanceSendStage };
    }
  }
  const contact2 = await contact(client, event3, true);
  const current = contact2 && contact2.ownerUserId === grant2.owner_user_id && contact2.email?.toLowerCase() === grant2.recipient_email && read(actor, contact2) && contactPermissionsFor(actor, contact2).canSendMail;
  let eventId, duplicate;
  if (current) {
    const recorded = await recordContactMailEventIn(client, actor, storedEvent);
    if (!recorded.ok)
      return recorded;
    eventId = recorded.data.eventId;
    duplicate = recorded.data.duplicate;
  } else {
    eventId = old?.event_id ?? (0, import_node_crypto10.randomUUID)();
    duplicate = !!old;
    if (!old)
      await client.query(
        `INSERT INTO crm_contact_mail_events(event_id,actor_id,contact_id,customer_id,event_key,mailbox_key,message_key,kind,direction,occurred_at,subject,preview,from_email,to_emails,cc_emails,digest,archive_only)
      VALUES($1,$2,$3,$4,$5,$6,$7,'sent','outbound',$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,true)`,
        [eventId, actor.userId, event3.contactId, event3.customerId, event3.eventKey, event3.mailboxKey, event3.messageKey, event3.occurredAt, event3.subject, event3.preview, event3.fromEmail, JSON.stringify(event3.toEmails), JSON.stringify(event3.ccEmails), contactMailFingerprint(event3)]
      );
    await client.query(
      `INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids)
      VALUES('crm.contact.mail.archived',$1,'crm',1,$2,$3::jsonb,'{}'::uuid[])`,
      [actor.userId, event3.customerId, JSON.stringify({ contactId: event3.contactId, customerId: event3.customerId, mailEventId: eventId, authorizationId: input.authorizationId })]
    );
  }
  await client.query("UPDATE crm_send_authorizations SET consumed_event_id=$2,consumed_fingerprint=$3,archived_after_revocation=$4 WHERE authorization_id=$1", [input.authorizationId, eventId, receiptFingerprint, !current]);
  return success({ eventId, duplicate, archivedAfterRevocation: !current });
}

// server/adapters/postgres/contact-mail-correction-schema.ts
var MAIL_CORRECTION_VERSION = "024-mail-classification-correction";
var MAIL_CORRECTION_SQL = `
ALTER TABLE crm_contact_mail_events ADD COLUMN classification_correction jsonb;
ALTER TABLE crm_contact_mail_events ADD COLUMN classification_revision integer;
ALTER TABLE crm_contact_mail_events ADD CONSTRAINT crm_mail_correction_shape CHECK (
  (classification_correction IS NULL AND classification_revision IS NULL)
  OR (
    classification_correction IS NOT NULL AND classification_revision IS NOT NULL
    AND classification_revision>0 AND direction='inbound' AND NOT send_stage_advanced
    AND jsonb_typeof(classification_correction)='object'
    AND classification_correction ?& ARRAY['previousEventKey','classification']
    AND (classification_correction-'previousEventKey'-'classification')='{}'::jsonb
    AND jsonb_typeof(classification_correction->'classification')='string'
    AND classification_correction->>'classification' IN ('other','replied','autoreply','bounced')
    AND kind=CASE classification_correction->>'classification'
      WHEN 'other' THEN 'received' ELSE classification_correction->>'classification' END
    AND (
      classification_correction->'previousEventKey'='null'::jsonb
      OR jsonb_typeof(classification_correction->'previousEventKey')='string'
    )
  )
);
CREATE UNIQUE INDEX idx_mail_correction_revision ON crm_contact_mail_events(
  actor_id,mailbox_key,message_key,contact_id,customer_id,classification_revision
) WHERE classification_revision IS NOT NULL;
CREATE INDEX idx_mail_activity_projection ON crm_contact_mail_events(activity_id)
  WHERE activity_id IS NOT NULL;
CREATE INDEX idx_mail_message_stream ON crm_contact_mail_events(
  actor_id,mailbox_key,message_key,contact_id,customer_id
);
`;

// server/adapters/postgres/contact-sharing-schema.ts
var CONTACT_SHARING_VERSION = "023-contact-sharing-public";
var CONTACT_SHARING_SQL = `
CREATE TABLE crm_contact_shares (
 share_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contact_id integer NOT NULL REFERENCES contacts(id),customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
 grantor_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),target_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
 editable_fields jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(editable_fields)='array' AND editable_fields <@ '["firstName","lastName","title","phone","linkedinUrl","country","language","clientType"]'::jsonb),can_followup boolean NOT NULL DEFAULT false,can_change_stage boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','revoked')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),decided_at timestamptz,
 FOREIGN KEY(customer_id,contact_id) REFERENCES crm_customer_contacts(customer_id,contact_id),CHECK(grantor_user_id<>target_user_id)
);
CREATE UNIQUE INDEX idx_contact_share_active ON crm_contact_shares(contact_id,target_user_id) WHERE status IN ('pending','accepted');
CREATE INDEX idx_contact_share_incoming ON crm_contact_shares(target_user_id,status,created_at DESC);
CREATE INDEX idx_contact_share_outgoing ON crm_contact_shares(grantor_user_id,status,created_at DESC);
`;

// server/adapters/postgres/contact-sharing-repository.ts
var import_node_crypto11 = require("node:crypto");
var SELECT2 = `SELECT sh.share_id AS "shareId",sh.contact_id AS "contactId",sh.customer_id AS "customerId",sh.grantor_user_id AS "grantorUserId",gu.display_name AS "grantorName",sh.target_user_id AS "targetUserId",tu.display_name AS "targetName",COALESCE(NULLIF(concat_ws(' ',ct.first_name,ct.last_name),''),'\u8054\u7CFB\u4EBA') AS "contactName",co.name AS "companyName",sh.editable_fields AS "editableFields",sh.can_followup AS "canFollowup",sh.can_change_stage AS "canChangeStage",sh.status,sh.version,sh.created_at AS "createdAt",(${validShareSql(CONTACT_OWNER_SQL)}) AS valid,c.created_by,c.origin FROM crm_contact_shares sh JOIN contacts ct ON ct.id=sh.contact_id JOIN crm_customers c ON c.customer_id=sh.customer_id JOIN companies co ON co.id=c.company_id JOIN public.identity_users gu ON gu.user_id=sh.grantor_user_id JOIN public.identity_users tu ON tu.user_id=sh.target_user_id`;
function manage(a, r) {
  return globalContactActor(a) || sourceContactManager(a, { ...r, ownerUserId: r.grantorUserId }) || r.grantorUserId === a.userId && r.valid;
}
function map(a, r) {
  const { valid: _, created_by: __, origin: ___, ...share } = r;
  const status = !r.valid && ["pending", "accepted"].includes(r.status) ? "revoked" : r.status;
  return { ...share, status, createdAt: new Date(r.createdAt).toISOString(), canAccept: status === "pending" && r.targetUserId === a.userId && a.capabilities.includes("leads.develop"), canReject: status === "pending" && r.targetUserId === a.userId, canManage: ["pending", "accepted"].includes(status) && manage(a, r) };
}
async function row(c, id, lock = false) {
  return (await c.query(`${SELECT2} WHERE sh.share_id=$1 ${lock ? "FOR UPDATE OF sh" : ""}`, [id])).rows[0];
}
async function result(c, a, id) {
  const r = await row(c, id);
  return !r || !manage(a, r) && r.targetUserId !== a.userId ? failure("NOT_FOUND", "\u5171\u4EAB\u8BF7\u6C42\u4E0D\u5B58\u5728") : success(map(a, r));
}
async function event(c, a, r, type) {
  const ct = await contact(c, r);
  await c.query("INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES($1,$2,'crm',$3,$4,$5,$6::uuid[])", [type, a.userId, r.version, r.customerId, JSON.stringify({ shareId: r.shareId, contactId: r.contactId, customerId: r.customerId, version: r.version, companyName: r.companyName, contactName: r.contactName }), [.../* @__PURE__ */ new Set([a.userId, r.grantorUserId, r.targetUserId, ...ct ? [ct.created_by] : []])].sort()]);
}
function allowedGrant(a, ct, i) {
  const p = contactPermissionsFor(a, ct);
  return p.canShare && i.editableFields.every((f) => CONTACT_SHARED_FIELDS.includes(f) && p.editableFields.includes(f)) && (!i.canFollowup || p.canFollowup) && (!i.canChangeStage || p.canChangeStage);
}
async function shareMembersIn(c, a) {
  if (!a.capabilities.includes("leads.develop"))
    return failure("FORBIDDEN", "\u65E0\u5171\u4EAB\u6743\u9650");
  const rows = await c.query(`SELECT u.user_id AS "userId",u.display_name AS "displayName",pa.capabilities,ARRAY(SELECT role FROM public.identity_product_grants WHERE user_id=u.user_id AND product_id='crm' AND active) AS roles FROM public.identity_users u JOIN public.identity_product_access pa ON pa.user_id=u.user_id AND pa.product_id='crm' AND pa.active WHERE u.active AND NOT u.must_change_password AND u.user_id<>$1`, [a.userId]);
  return success(rows.rows.filter((m) => m.roles.includes("sales") && effectiveCapabilitiesFor(m.roles, m.capabilities).includes("leads.develop")).map((m) => ({ userId: m.userId, displayName: m.displayName })));
}
async function sharesIn(c, a, q) {
  if (!a.capabilities.includes("leads.develop"))
    return failure("FORBIDDEN", "\u65E0\u5171\u4EAB\u8BBF\u95EE\u6743\u9650");
  const permission = q.view === "incoming" ? "sh.target_user_id=$1" : `(sh.grantor_user_id=$1 OR $2::boolean OR ($3::boolean AND c.origin='operations'))`;
  const effectiveStatus = `CASE WHEN sh.status IN ('pending','accepted') AND NOT (${validShareSql(CONTACT_OWNER_SQL)}) THEN 'revoked' ELSE sh.status END`;
  const where = `WHERE ct.crm_deleted_at IS NULL AND co.crm_deleted_at IS NULL AND ${permission} AND ($4::text IS NULL OR (${effectiveStatus})=$4) AND ($5::integer IS NULL OR sh.contact_id=$5) AND ($6::uuid IS NULL OR sh.customer_id=$6)`;
  const params = [a.userId, globalContactActor(a), a.roles.includes("operations") && ["shared", "summary"].includes(a.scope) && a.capabilities.includes("leads.assign"), q.status ?? null, q.contactId ?? null, q.customerId ?? null];
  const filter = where.replace("WHERE ct.crm_deleted_at", "WHERE $2::boolean IS NOT NULL AND $3::boolean IS NOT NULL AND ct.crm_deleted_at");
  const rows = await c.query(`${SELECT2} ${filter} ORDER BY sh.created_at DESC,sh.share_id DESC LIMIT $7 OFFSET $8`, [...params, q.limit, q.offset]);
  const count = await c.query(`SELECT count(*)::int AS n FROM (${SELECT2} ${filter}) q`, params);
  return success({ items: rows.rows.map((r) => map(a, r)), total: count.rows[0].n });
}
async function createShareIn(c, a, input) {
  const ct = await contact(c, input, true);
  if (!ct || !read(a, ct) || !allowedGrant(a, ct, input))
    return failure("FORBIDDEN", "\u6CA1\u6709\u6240\u9009\u5171\u4EAB\u6743\u9650");
  const eligible = await shareMembersIn(c, a);
  if (!eligible.ok)
    return eligible;
  if (!eligible.data.some((m) => m.userId === input.targetUserId))
    return failure("INVALID_INPUT", "\u63A5\u6536\u7528\u6237\u4E0D\u53EF\u7528");
  return cached(c, a, "contact-share:create", input, async () => {
    if (ct.contactVersion !== input.expectedVersion)
      return failure("CONFLICT", "\u8054\u7CFB\u4EBA\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5");
    await c.query(`UPDATE crm_contact_shares sh SET status='revoked',version=sh.version+1,updated_at=now(),decided_at=now() FROM crm_customers c WHERE sh.contact_id=$1 AND sh.customer_id=c.customer_id AND sh.status IN ('pending','accepted') AND NOT (${validShareSql(CONTACT_OWNER_SQL.replaceAll("ct.id", "sh.contact_id"))})`, [input.contactId]);
    if ((await c.query("SELECT 1 FROM crm_contact_shares WHERE contact_id=$1 AND target_user_id=$2 AND status IN ('pending','accepted')", [input.contactId, input.targetUserId])).rowCount)
      return failure("CONFLICT", "\u8BE5\u7528\u6237\u5DF2\u6709\u5171\u4EAB\u9080\u8BF7\u6216\u534F\u4F5C\u6743\u9650");
    const id = (0, import_node_crypto11.randomUUID)();
    await c.query("INSERT INTO crm_contact_shares(share_id,contact_id,customer_id,grantor_user_id,target_user_id,editable_fields,can_followup,can_change_stage) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)", [id, input.contactId, input.customerId, a.userId, input.targetUserId, JSON.stringify(input.editableFields), input.canFollowup, input.canChangeStage]);
    const r = await result(c, a, id);
    if (r.ok)
      await event(c, a, r.data, CONTACT_SHARING_EVENTS.requested);
    return r;
  }, (old) => result(c, a, old.shareId));
}
async function decideShareIn(c, a, action, input) {
  const r = await row(c, input.shareId, true);
  if (!r || (action === "revoke" ? !manage(a, r) && !(r.targetUserId === a.userId && ["accepted", "revoked"].includes(r.status)) : r.targetUserId !== a.userId))
    return failure("NOT_FOUND", "\u5171\u4EAB\u8BF7\u6C42\u4E0D\u5B58\u5728");
  return cached(c, a, `contact-share:${action}`, input, async () => {
    if (r.version !== input.expectedVersion || (action === "revoke" ? !["pending", "accepted"].includes(r.status) : r.status !== "pending"))
      return failure("CONFLICT", "\u5171\u4EAB\u72B6\u6001\u5DF2\u53D8\u5316");
    if (action === "accept") {
      const ct = await contact(c, r, true);
      if (!ct || !r.valid || (!a.capabilities.includes("leads.develop") || !a.roles.includes("sales")))
        return failure("FORBIDDEN", "\u5171\u4EAB\u6388\u6743\u5DF2\u5931\u6548");
    }
    const status = action === "accept" ? "accepted" : action === "reject" ? "rejected" : "revoked";
    await c.query("UPDATE crm_contact_shares SET status=$2,version=version+1,updated_at=now(),decided_at=now() WHERE share_id=$1", [r.shareId, status]);
    await c.query("UPDATE contacts SET crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1", [r.contactId]);
    const next = await result(c, a, r.shareId);
    if (next.ok) {
      await event(c, a, next.data, CONTACT_SHARING_EVENTS[status]);
      const ct = await contact(c, r);
      if (ct)
        await contactEvent(c, a, ct, "crm.contact.updated", ct.contactVersion ?? 1);
    }
    return next;
  }, (old) => result(c, a, old.shareId));
}
async function updateShareIn(c, a, input) {
  const r = await row(c, input.shareId, true);
  if (!r || !manage(a, r))
    return failure("NOT_FOUND", "\u5171\u4EAB\u8BF7\u6C42\u4E0D\u5B58\u5728");
  const ct = await contact(c, r, true);
  if (!ct || !r.valid)
    return failure("FORBIDDEN", "\u5171\u4EAB\u6388\u6743\u5DF2\u5931\u6548");
  const allowed = contactPermissionsFor({ ...a, userId: r.grantorUserId, roles: ["sales"], scope: "own", capabilities: ["leads.develop"] }, ct);
  if (input.editableFields.some((f) => !CONTACT_SHARED_FIELDS.includes(f) || !allowed.editableFields.includes(f)))
    return failure("FORBIDDEN", "\u4E0D\u80FD\u6388\u4E88\u6240\u9009\u5B57\u6BB5\u6743\u9650");
  return cached(c, a, "contact-share:update", input, async () => {
    if (r.version !== input.expectedVersion || !["pending", "accepted"].includes(r.status))
      return failure("CONFLICT", "\u5171\u4EAB\u72B6\u6001\u5DF2\u53D8\u5316");
    await c.query("UPDATE crm_contact_shares SET editable_fields=$2::jsonb,can_followup=$3,can_change_stage=$4,version=version+1,updated_at=now() WHERE share_id=$1", [r.shareId, JSON.stringify(input.editableFields), input.canFollowup, input.canChangeStage]);
    await c.query("UPDATE contacts SET crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1", [r.contactId]);
    const next = await result(c, a, r.shareId);
    if (next.ok)
      await event(c, a, next.data, CONTACT_SHARING_EVENTS.updated);
    return next;
  }, (old) => result(c, a, old.shareId));
}

// server/adapters/postgres/lead-repository.ts
var import_node_crypto13 = require("node:crypto");

// server/adapters/postgres/lead-schema.ts
var LEAD_VERSION = "005-lead-collaboration-public";
var LEAD_LOCK = 19041005;
var LEAD_SQL = `
CREATE TABLE crm_customers (
 customer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id integer NOT NULL REFERENCES companies(id),
 source text NOT NULL,customer_key text NOT NULL,source_detail text NOT NULL,
 state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','published','owned','paused')),
 owner_user_id uuid REFERENCES public.identity_users(user_id),created_by uuid NOT NULL REFERENCES public.identity_users(user_id),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source,customer_key),CHECK((state='owned')=(owner_user_id IS NOT NULL))
);
CREATE TABLE crm_customer_contacts(customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),contact_id integer PRIMARY KEY REFERENCES contacts(id));
CREATE TABLE crm_import_batches(batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),source text NOT NULL,source_detail text NOT NULL,mapping jsonb NOT NULL DEFAULT '{}',version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE crm_import_rows(row_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),batch_id uuid NOT NULL REFERENCES crm_import_batches(batch_id),row_index integer NOT NULL,customer_key text NOT NULL,raw_row jsonb NOT NULL,customer_id uuid REFERENCES crm_customers(customer_id),status text NOT NULL CHECK(status IN ('created','duplicate','invalid','restricted_conflict')),UNIQUE(batch_id,row_index));
CREATE TABLE crm_assignment_history(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),owner_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE crm_shared_activities(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),interaction_id integer NOT NULL REFERENCES interactions(id),actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),note text NOT NULL,stage text,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE crm_lead_idempotency(actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),operation text NOT NULL,key text NOT NULL,digest text NOT NULL,response jsonb NOT NULL,PRIMARY KEY(actor_id,operation,key));
ALTER TABLE public.identity_outbox ADD COLUMN customer_id uuid REFERENCES crm_customers(customer_id);
CREATE INDEX idx_crm_customers_owner ON crm_customers(owner_user_id,state);
`;

// server/adapters/postgres/customer-schema.ts
var CUSTOMER_VERSION = "008-center-customers";
var CUSTOMER_SQL = `
ALTER TABLE crm_customers ADD COLUMN origin text NOT NULL DEFAULT 'operations' CHECK(origin IN ('operations','personal'));
CREATE INDEX idx_crm_customers_creator_origin ON crm_customers(created_by,origin);
`;

// server/adapters/postgres/customer-profile-schema.ts
var CUSTOMER_PROFILE_VERSION = "011-customer-workbook-profile-public";
var CUSTOMER_PROFILE_SQL = `
ALTER TABLE crm_customers ADD COLUMN business_type text;
ALTER TABLE crm_customers ADD COLUMN development_restriction text;
ALTER TABLE crm_customers ADD COLUMN source_created_at timestamptz;
ALTER TABLE contacts ALTER COLUMN email DROP NOT NULL;
ALTER TABLE crm_import_rows DROP CONSTRAINT crm_import_rows_status_check;
ALTER TABLE crm_import_rows ADD CONSTRAINT crm_import_rows_status_check CHECK(status IN ('created','appended','duplicate','invalid','unmatched','ambiguous','restricted_conflict'));
CREATE TABLE crm_workbook_source_mappings (
 actor_id uuid NOT NULL REFERENCES public.identity_users(user_id), source text NOT NULL,
 origin text NOT NULL CHECK(origin IN ('personal','operations')),
 entity text NOT NULL CHECK(entity IN ('customer','contact')), source_ref text NOT NULL,
 customer_ref text NOT NULL, customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
 contact_id integer REFERENCES contacts(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((entity='contact')=(contact_id IS NOT NULL)),
 PRIMARY KEY(actor_id,source,origin,entity,source_ref)
);
CREATE INDEX idx_crm_customer_contacts_customer ON crm_customer_contacts(customer_id,contact_id);
CREATE INDEX idx_crm_shared_activities_customer ON crm_shared_activities(customer_id,id DESC);
`;

// server/adapters/postgres/lead-field-extension-schema.ts
var LEAD_FIELD_EXTENSION_VERSION = "030-lead-field-extension";
var LEAD_FIELD_EXTENSION_SQL = `
ALTER TABLE companies ADD COLUMN customer_type text CHECK (customer_type IS NULL OR customer_type IN ('\u4EE3\u7406','\u76F4\u5BA2'));
ALTER TABLE contacts ADD COLUMN whatsapp text;
ALTER TABLE contacts ADD COLUMN source_level1 text;
ALTER TABLE contacts ADD COLUMN source_level2 text;
ALTER TABLE crm_contact_shares DROP CONSTRAINT IF EXISTS crm_contact_shares_editable_fields_check;
ALTER TABLE crm_contact_shares ADD CONSTRAINT crm_contact_shares_editable_fields_check CHECK(jsonb_typeof(editable_fields)='array' AND editable_fields <@ '["firstName","lastName","title","phone","whatsapp","linkedinUrl","country","language","clientType"]'::jsonb);
`;

// server/adapters/postgres/followup-schema.ts
var FOLLOWUP_VERSION = "012-customer-followup";
var stages = ["cold", ...CRM_STAGES].map((value2) => `'${value2}'`).join(",");
var statuses = ["uncontacted", "contacted", "replied", "unreachable"].map((value2) => `'${value2}'`).join(",");
var methods = ["legacy", ...FOLLOWUP_METHODS].map((value2) => `'${value2}'`).join(",");
var FOLLOWUP_SQL = `
ALTER TABLE crm_customers ADD COLUMN relationship_stage text NOT NULL DEFAULT 'cold' CHECK(relationship_stage IN (${stages}));
ALTER TABLE crm_customers ADD COLUMN stage_needs_review boolean NOT NULL DEFAULT false;
ALTER TABLE crm_customers ADD COLUMN legacy_stage_snapshot jsonb NOT NULL DEFAULT '[]';
WITH legacy AS (
 SELECT c.customer_id,COALESCE(jsonb_agg(jsonb_build_object('contactId',ct.id,'stage',ct.stage) ORDER BY ct.id) FILTER(WHERE ct.id IS NOT NULL),'[]'::jsonb) AS snapshot,
 count(ct.id)::int AS contacts,count(DISTINCT ct.stage)::int AS variants,
 bool_and(ct.stage IN (${stages})) FILTER(WHERE ct.id IS NOT NULL) AS legal,min(ct.stage) AS uniform_stage
 FROM crm_customers c LEFT JOIN crm_customer_contacts cc ON cc.customer_id=c.customer_id LEFT JOIN contacts ct ON ct.id=cc.contact_id GROUP BY c.customer_id
)
UPDATE crm_customers c SET legacy_stage_snapshot=legacy.snapshot,
 relationship_stage=CASE WHEN legacy.contacts>0 AND legacy.variants=1 AND legacy.legal THEN legacy.uniform_stage ELSE 'cold' END,
 stage_needs_review=legacy.contacts>0 AND NOT COALESCE(legacy.variants=1 AND legacy.legal,false)
FROM legacy WHERE legacy.customer_id=c.customer_id;
ALTER TABLE contacts ADD COLUMN crm_touch_status text NOT NULL DEFAULT 'uncontacted' CHECK(crm_touch_status IN (${statuses}));
ALTER TABLE crm_shared_activities ALTER COLUMN interaction_id DROP NOT NULL;
ALTER TABLE crm_shared_activities ADD COLUMN method text NOT NULL DEFAULT 'legacy' CHECK(method IN (${methods}));
ALTER TABLE crm_shared_activities ADD COLUMN occurred_at timestamptz;
ALTER TABLE crm_shared_activities ADD COLUMN recorded_at timestamptz;
UPDATE crm_shared_activities SET occurred_at=created_at,recorded_at=created_at;
ALTER TABLE crm_shared_activities ALTER COLUMN occurred_at SET NOT NULL;
ALTER TABLE crm_shared_activities ALTER COLUMN occurred_at SET DEFAULT now();
ALTER TABLE crm_shared_activities ALTER COLUMN recorded_at SET NOT NULL;
ALTER TABLE crm_shared_activities ALTER COLUMN recorded_at SET DEFAULT now();
ALTER TABLE crm_shared_activities ADD COLUMN contact_id integer REFERENCES contacts(id);
ALTER TABLE crm_shared_activities ADD COLUMN contact_status text CHECK(contact_status IN (${statuses}));
ALTER TABLE crm_shared_activities ADD CONSTRAINT crm_activity_touch_requires_contact CHECK(contact_status IS NULL OR (contact_id IS NOT NULL AND method NOT IN ('note','legacy')));
CREATE INDEX idx_crm_activities_occurred ON crm_shared_activities(customer_id,occurred_at DESC,id DESC);
`;

// server/adapters/postgres/contact-touch-status-schema.ts
var CONTACT_TOUCH_STATUS_VERSION = "031-contact-touch-outcomes";
var statuses2 = CONTACT_TOUCH_STATUSES.map((value2) => `'${value2}'`).join(",");
var CONTACT_TOUCH_STATUS_SQL = `
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_crm_touch_status_check;
UPDATE contacts SET crm_touch_status=CASE
 WHEN status='replied' THEN 'replied'
 WHEN status='bounced' THEN 'bounced'
 WHEN status='autoreply' THEN 'autoreply'
 WHEN status='reached' AND crm_touch_status='uncontacted' THEN 'contacted'
 WHEN crm_touch_status='unreachable' THEN 'uncontacted'
 ELSE crm_touch_status END;
ALTER TABLE contacts ADD CONSTRAINT contacts_crm_touch_status_check CHECK(crm_touch_status IN (${statuses2}));
ALTER TABLE crm_shared_activities DROP CONSTRAINT IF EXISTS crm_shared_activities_contact_status_check;
UPDATE crm_shared_activities SET contact_status='uncontacted' WHERE contact_status='unreachable';
ALTER TABLE crm_shared_activities ADD CONSTRAINT crm_shared_activities_contact_status_check CHECK(contact_status IS NULL OR contact_status IN (${statuses2}));
`;

// server/adapters/postgres/workbook-import-repository.ts
var import_node_crypto12 = require("node:crypto");

// server/core/customer-import.ts
var WORKBOOK_IMPORT_ROUTE = "/api/crm/workbook-imports";
var WORKBOOK_LIMITS = { sheets: 20, columns: 100, entityRows: 1e4, totalRows: 2e4, reference: 500, batchRows: 200, bodyBytes: 1048576 };
var FIELD_LIMIT = 4096;
var EMAIL_LIMIT = 254;
var CLOCK_HOUR_MAX = 23;
var CLOCK_MINUTE_SECOND_MAX = 59;
function normalizeSourceDate(value2) {
  const match = /^(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})\/(\d{1,2})\/(\d{1,2}))(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value2);
  if (!match)
    return void 0;
  const year = Number(match[1] ?? match[4]);
  const month = Number(match[2] ?? match[5]);
  const day = Number(match[3] ?? match[6]);
  if (!year)
    return void 0;
  const calendar = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const date = /* @__PURE__ */ new Date(`${calendar}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day)
    return void 0;
  if (!match[7])
    return date.toISOString();
  if (Number(match[7]) > CLOCK_HOUR_MAX || Number(match[8]) > CLOCK_MINUTE_SECOND_MAX || Number(match[9] ?? 0) > CLOCK_MINUTE_SECOND_MAX)
    return void 0;
  const zone = match[11] ?? "Z";
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > CLOCK_HOUR_MAX || Number(zone.slice(4)) > CLOCK_MINUTE_SECOND_MAX))
    return void 0;
  const time = `${match[7]}:${match[8]}:${match[9] ?? "00"}${match[10] ? `.${match[10]}` : ""}${zone}`;
  const timestamp = Date.parse(`${calendar}T${time}`);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : void 0;
}
function workbookRowIssue(row2) {
  if (!row2 || !["customer", "contact"].includes(row2.entity))
    return "\u8BB0\u5F55\u7C7B\u578B\u65E0\u6548";
  if (!row2.sourceRef?.trim() || row2.sourceRef.length > WORKBOOK_LIMITS.reference)
    return "\u6765\u6E90\u5F15\u7528\u7F3A\u5931\u6216\u8FC7\u957F";
  if (!row2.sheetName?.trim() || !Number.isSafeInteger(row2.rowNumber) || row2.rowNumber < 1)
    return "\u6765\u6E90\u884C\u5B9A\u4F4D\u65E0\u6548";
  if (row2.entity === "customer" && !row2.companyName?.trim())
    return "\u5BA2\u6237\u62AC\u5934\u4E3A\u7A7A";
  if (row2.entity === "customer" && row2.customerType && !["\u4EE3\u7406", "\u76F4\u5BA2"].includes(row2.customerType.trim()))
    return "\u5BA2\u6237\u7C7B\u578B\u53EA\u80FD\u586B\u5199\u4EE3\u7406\u6216\u76F4\u5BA2";
  if (row2.entity === "contact" && !row2.customerRef?.trim())
    return "\u8054\u7CFB\u4EBA\u7F3A\u5C11\u5BA2\u6237\u5173\u8054";
  if (row2.customerRef && row2.customerRef.length > WORKBOOK_LIMITS.reference)
    return "\u5BA2\u6237\u5173\u8054\u5F15\u7528\u8FC7\u957F";
  if (row2.entity === "contact" && ![row2.email, row2.name, row2.firstName, row2.lastName, row2.phone, row2.whatsapp].some((value2) => value2?.trim()))
    return "\u8054\u7CFB\u4EBA\u59D3\u540D\u3001\u7535\u8BDD\u6216\u90AE\u7BB1\u81F3\u5C11\u586B\u5199\u4E00\u9879";
  if (row2.email && (row2.email.length > EMAIL_LIMIT || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row2.email)))
    return "\u8054\u7CFB\u4EBA\u90AE\u7BB1\u683C\u5F0F\u65E0\u6548\u6216\u8D85\u8FC7254\u5B57\u7B26";
  if ([row2.companyName, row2.country, row2.customerType, row2.businessType, row2.developmentRestriction, row2.name, row2.phone, row2.whatsapp, row2.title, row2.firstName, row2.lastName, row2.linkedinUrl, row2.language, row2.clientType, row2.sourceLevel1, row2.sourceLevel2, row2.stage, row2.status].some((value2) => value2 !== void 0 && value2.length > LEAD_LIMITS.text))
    return "\u5BA2\u6237\u6216\u8054\u7CFB\u4EBA\u5B57\u6BB5\u5185\u5BB9\u8FC7\u957F";
  if (row2.tags !== void 0 && (!Array.isArray(row2.tags) || row2.tags.length > LEAD_LIMITS.pageMax || row2.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > LEAD_LIMITS.text)))
    return "\u8054\u7CFB\u4EBA\u6807\u7B7E\u65E0\u6548";
  if (row2.sourceCreatedAt && !normalizeSourceDate(row2.sourceCreatedAt))
    return "\u6E90\u521B\u5EFA\u65F6\u95F4\u65E0\u6548\uFF0C\u8BF7\u4F7F\u7528YYYY-MM-DD\u6216YYYY/M/D\u53CA\u6709\u6548\u65F6\u95F4";
  if (Object.values(row2).some((value2) => typeof value2 === "string" && value2.length > FIELD_LIMIT))
    return "\u5B57\u6BB5\u5185\u5BB9\u8FC7\u957F";
  return void 0;
}

// server/adapters/postgres/workbook-import-repository.ts
function value(input) {
  return input?.trim() || null;
}
function customerMatches(row2, current) {
  return current.company_name === row2.companyName?.trim() && current.country === value(row2.country) && current.customer_type === value(row2.customerType) && current.business_type === value(row2.businessType) && current.development_restriction === value(row2.developmentRestriction) && (current.source_created_at?.toISOString() ?? null) === (row2.sourceCreatedAt ? normalizeSourceDate(row2.sourceCreatedAt) : null);
}
function editable(actor, customer2, kind) {
  return customer2.created_by === actor.userId && customer2.origin === kind && (kind === "personal" ? customer2.state === "owned" && customer2.owner_user_id === actor.userId : customer2.state === "draft" && customer2.owner_user_id === null);
}
async function mapping(c, actor, input, entity, ref2) {
  return (await c.query("SELECT * FROM crm_workbook_source_mappings WHERE actor_id=$1 AND source=$2 AND origin=$3 AND entity=$4 AND source_ref=$5", [actor.userId, input.source, input.kind, entity, ref2])).rows[0];
}
async function customer(c, id) {
  return (await c.query(`SELECT cu.*,co.name AS company_name,co.country,co.customer_type FROM crm_customers cu JOIN companies co ON co.id=cu.company_id WHERE cu.customer_id=$1 FOR UPDATE OF cu`, [id])).rows[0];
}
async function saveMapping(c, actor, input, row2, customerId, contactId) {
  await c.query("INSERT INTO crm_workbook_source_mappings(actor_id,source,origin,entity,source_ref,customer_ref,customer_id,contact_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [actor.userId, input.source, input.kind, row2.entity, row2.sourceRef.trim(), row2.entity === "customer" ? row2.sourceRef.trim() : row2.customerRef.trim(), customerId, contactId ?? null]);
}
async function importCustomer(c, actor, input, row2) {
  const linked = await mapping(c, actor, input, "customer", row2.sourceRef.trim());
  if (linked) {
    const current = await customer(c, linked.customer_id);
    if (!current || !editable(actor, current, input.kind))
      return { status: "restricted_conflict", message: "\u9700\u6838\u5B9E\u6765\u6E90\u6216\u5BA2\u6237\u5F52\u5C5E" };
    if (!customerMatches(row2, current))
      return { status: "ambiguous", customerId: current.customer_id, message: "\u6765\u6E90\u5BA2\u6237\u8D44\u6599\u5DF2\u53D8\u5316\uFF0C\u8BF7\u6838\u5BF9\u540E\u4FEE\u6539\u4E3B\u6863" };
    return { status: "duplicate", customerId: current.customer_id };
  }
  const co = await c.query("INSERT INTO companies(name,country,customer_type) VALUES($1,$2,$3) RETURNING id", [row2.companyName.trim(), value(row2.country), value(row2.customerType)]);
  const id = (0, import_node_crypto12.randomUUID)();
  await c.query(`INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin,state,owner_user_id,business_type,development_restriction,source_created_at) VALUES($1,$2,$3,$1::uuid::text,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, co.rows[0].id, input.source, input.sourceDetail, actor.userId, input.kind, input.kind === "personal" ? "owned" : "draft", input.kind === "personal" ? actor.userId : null, value(row2.businessType), value(row2.developmentRestriction), row2.sourceCreatedAt ? normalizeSourceDate(row2.sourceCreatedAt) : null]);
  await saveMapping(c, actor, input, row2, id);
  if (input.kind === "personal")
    await event2(c, actor, id, 1, "crm.customer.created");
  return { status: "created", customerId: id };
}
function contactValues(row2) {
  return { email: value(row2.email)?.toLowerCase() ?? null, first_name: value(row2.firstName ?? row2.name), last_name: value(row2.lastName), country: value(row2.country), phone: value(row2.phone), whatsapp: value(row2.whatsapp), title: value(row2.title), linkedin: value(row2.linkedinUrl), language: value(row2.language), client_type: value(row2.clientType), source_level1: value(row2.sourceLevel1), source_level2: value(row2.sourceLevel2), stage: value(row2.stage) ?? "cold", status: value(row2.status) ?? "", tags: row2.tags ?? [] };
}
function contactMatches(row2, current) {
  return Object.entries(contactValues(row2)).every(([key, v]) => key === "tags" ? JSON.stringify(current[key]) === JSON.stringify(v) : current[key] === v);
}
async function restoreContact(c, actor, input, row2, customerId, contactId) {
  const existing = await contact(c, { contactId, customerId }, true, true);
  if (!existing || !canDeleteContact(actor, existing))
    return { status: "restricted_conflict", customerId, message: "\u539F\u8054\u7CFB\u4EBA\u4E0D\u53EF\u6062\u590D\uFF0C\u8BF7\u6838\u5B9E\u5220\u9664\u6743\u9650\u6216\u5206\u914D\u72B6\u6001" };
  const fields = contactValues(row2);
  const restored = await c.query(`UPDATE contacts SET company_id=(SELECT company_id FROM crm_customers WHERE customer_id=$2),
  first_name=COALESCE($3,first_name),last_name=COALESCE($4,last_name),country=COALESCE($5,country),phone=COALESCE($6,phone),whatsapp=COALESCE($7,whatsapp),title=COALESCE($8,title),linkedin=COALESCE($9,linkedin),language=COALESCE($10,language),client_type=COALESCE($11,client_type),source_level1=COALESCE($12,source_level1),source_level2=COALESCE($13,source_level2),stage=COALESCE($14,stage),status=COALESCE($15,status),tags=CASE WHEN $16::jsonb='[]'::jsonb THEN tags ELSE $16::jsonb END,
  crm_deleted_at=NULL,crm_deleted_by=NULL,crm_contact_version=crm_contact_version+1,updated_at=clock_timestamp()
  WHERE id=$1 AND crm_deleted_at IS NOT NULL RETURNING crm_contact_version`, [contactId, customerId, fields.first_name, fields.last_name, fields.country, fields.phone, fields.whatsapp, fields.title, fields.linkedin, fields.language, fields.client_type, fields.source_level1, fields.source_level2, fields.stage, fields.status, JSON.stringify(fields.tags)]);
  if (!restored.rows.length)
    return { status: "ambiguous", customerId, message: "\u8054\u7CFB\u4EBA\u6062\u590D\u72B6\u6001\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5" };
  await c.query("INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2) ON CONFLICT(contact_id) DO NOTHING", [customerId, contactId]);
  await event2(c, actor, customerId, restored.rows[0].crm_contact_version, "crm.contact.updated", contactId);
  return { status: "appended", customerId };
}
async function importContact(c, actor, input, row2, blocked) {
  const parentRef = row2.customerRef.trim();
  if (blocked.has(parentRef))
    return { status: "ambiguous", message: "\u6765\u6E90\u5BA2\u6237\u8D44\u6599\u5F85\u6838\u5BF9" };
  const parent = await mapping(c, actor, input, "customer", parentRef);
  if (!parent)
    return { status: "unmatched", message: "\u7F3A\u5C11\u5DF2\u786E\u8BA4\u7684\u6765\u6E90\u5BA2\u6237\u5173\u8054" };
  const current = await customer(c, parent.customer_id);
  if (!current || !editable(actor, current, input.kind))
    return { status: "restricted_conflict", message: "\u9700\u6838\u5B9E\u6765\u6E90\u6216\u5BA2\u6237\u5F52\u5C5E" };
  const linked = await mapping(c, actor, input, "contact", row2.sourceRef.trim());
  if (linked) {
    if (linked.customer_id !== current.customer_id || linked.customer_ref !== parentRef)
      return { status: "ambiguous", message: "\u8054\u7CFB\u4EBA\u6240\u5C5E\u5BA2\u6237\u5DF2\u53D8\u5316\uFF0C\u8BF7\u6838\u5BF9\u5173\u8054" };
    const co2 = (await c.query("SELECT * FROM contacts WHERE id=$1", [linked.contact_id])).rows[0];
    if (co2?.crm_deleted_at)
      return restoreContact(c, actor, input, row2, current.customer_id, co2.id);
    if (co2 && (await c.query("SELECT 1 FROM crm_contact_assignment_requests WHERE contact_id=$1 AND status IN ('pending','accepted')", [co2.id])).rows.length)
      return { status: "restricted_conflict", message: "\u8054\u7CFB\u4EBA\u5DF2\u8FDB\u5165\u72EC\u7ACB\u5206\u914D\u6D41\u7A0B" };
    if (!co2 || !contactMatches(row2, co2))
      return { status: "ambiguous", customerId: current.customer_id, message: "\u6765\u6E90\u8054\u7CFB\u4EBA\u8D44\u6599\u5DF2\u53D8\u5316\uFF0C\u8BF7\u6838\u5BF9\u540E\u4FEE\u6539\u4E3B\u6863" };
    return { status: "duplicate", customerId: current.customer_id };
  }
  const email3 = value(row2.email)?.toLowerCase() ?? null;
  if (email3) {
    const existing = (await c.query("SELECT co.*,cc.customer_id FROM contacts co LEFT JOIN crm_customer_contacts cc ON cc.contact_id=co.id WHERE co.email=$1", [email3])).rows[0];
    if (existing) {
      if (existing.customer_id !== current.customer_id)
        return { status: "restricted_conflict", message: "\u8054\u7CFB\u4EBA\u4FE1\u606F\u51B2\u7A81\uFF0C\u8BF7\u6838\u5B9E\u6765\u6E90" };
      if (existing.crm_deleted_at) {
        const result2 = await restoreContact(c, actor, input, row2, current.customer_id, existing.id);
        if (result2.status === "appended")
          await saveMapping(c, actor, input, row2, current.customer_id, existing.id);
        return result2;
      }
      if (!contactMatches(row2, existing))
        return { status: "ambiguous", customerId: current.customer_id, message: "\u5DF2\u6709\u8054\u7CFB\u4EBA\u8D44\u6599\u4E0D\u4E00\u81F4\uFF0C\u8BF7\u6838\u5BF9" };
      await saveMapping(c, actor, input, row2, current.customer_id, existing.id);
      return { status: "duplicate", customerId: current.customer_id };
    }
  }
  const fields = contactValues(row2);
  const co = await c.query("INSERT INTO contacts(email,company_id,first_name,last_name,country,phone,whatsapp,title,linkedin,language,client_type,source_level1,source_level2,stage,status,tags,source,source_detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18) RETURNING id", [email3, current.company_id, fields.first_name, fields.last_name, fields.country, fields.phone, fields.whatsapp, fields.title, fields.linkedin, fields.language, fields.client_type, fields.source_level1, fields.source_level2, fields.stage, fields.status, JSON.stringify(fields.tags), input.source, input.sourceDetail]);
  await c.query("INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)", [current.customer_id, co.rows[0].id]);
  await saveMapping(c, actor, input, row2, current.customer_id, co.rows[0].id);
  await c.query("UPDATE crm_customers SET version=version+1 WHERE customer_id=$1", [current.customer_id]);
  if (input.kind === "personal")
    await event2(c, actor, current.customer_id, current.version + 1, "crm.customer.updated");
  return { status: "appended", customerId: current.customer_id };
}
async function event2(c, actor, id, version3, type, contactId) {
  await c.query("INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload) VALUES($1,$2,$3,$4,$5,$6)", [type, actor.userId, "crm", version3, id, JSON.stringify({ customerId: id, version: version3, ...contactId ? { contactId } : {} })]);
}
async function importWorkbookIn(c, actor, input) {
  const batchId = (0, import_node_crypto12.randomUUID)();
  await c.query("INSERT INTO crm_import_batches(batch_id,actor_id,source,source_detail,mapping) VALUES($1,$2,$3,$4,$5)", [batchId, actor.userId, input.source, input.sourceDetail, JSON.stringify({ format: "workbook", kind: input.kind })]);
  const receipts = new Array(input.rows.length), blocked = /* @__PURE__ */ new Set();
  for (const entity of ["customer", "contact"])
    for (const [index, row2] of input.rows.entries()) {
      if (row2.entity !== entity)
        continue;
      const issue = workbookRowIssue(row2);
      const outcome = issue ? { status: "invalid", message: issue } : entity === "customer" ? await importCustomer(c, actor, input, row2) : await importContact(c, actor, input, row2, blocked);
      if (entity === "customer" && !["created", "duplicate"].includes(outcome.status))
        blocked.add(row2.sourceRef.trim());
      const receipt = { rowId: (0, import_node_crypto12.randomUUID)(), index, entity, sheetName: row2.sheetName, rowNumber: row2.rowNumber, ...outcome };
      await c.query("INSERT INTO crm_import_rows(row_id,batch_id,row_index,customer_key,raw_row,customer_id,status) VALUES($1,$2,$3,$4,$5,$6,$7)", [receipt.rowId, batchId, index, row2.sourceRef, JSON.stringify({ input: row2, rawRow: row2.rawRow, entity, sheetName: row2.sheetName, rowNumber: row2.rowNumber }), outcome.customerId ?? null, outcome.status]);
      receipts[index] = receipt;
    }
  return success({ batchId, rows: receipts });
}

// server/adapters/postgres/contact-assignment-schema.ts
var CONTACT_ASSIGNMENT_VERSION = "019-contact-assignment-acceptance-public";
var CONTACT_ASSIGNMENT_SQL = `
ALTER TABLE contacts ADD COLUMN crm_contact_version integer NOT NULL DEFAULT 1 CHECK(crm_contact_version>0);
ALTER TABLE crm_customer_contacts ADD CONSTRAINT crm_customer_contacts_pair UNIQUE(customer_id,contact_id);
CREATE TABLE crm_contact_assignment_requests (
 request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id integer NOT NULL REFERENCES contacts(id),
 customer_id uuid NOT NULL REFERENCES crm_customers(customer_id), target_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
 actor_id uuid NOT NULL REFERENCES public.identity_users(user_id), notify_user_ids uuid[] NOT NULL DEFAULT '{}',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','cancelled')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
 FOREIGN KEY(customer_id,contact_id) REFERENCES crm_customer_contacts(customer_id,contact_id)
);
CREATE UNIQUE INDEX idx_crm_contact_active_assignment ON crm_contact_assignment_requests(contact_id) WHERE status IN ('pending','accepted');
CREATE INDEX idx_crm_contact_assignment_target ON crm_contact_assignment_requests(target_user_id,status,created_at DESC);
CREATE INDEX idx_crm_contact_assignment_actor ON crm_contact_assignment_requests(actor_id,status,created_at DESC);
`;

// server/adapters/postgres/contact-mail-schema.ts
var CONTACT_MAIL_VERSION = "020-contact-mail-events-public";
var CONTACT_MAIL_SEND_STAGE_VERSION = "021-contact-mail-send-stage-public";
var CONTACT_MAIL_SEND_STAGE_SQL = "ALTER TABLE crm_contact_mail_events ADD COLUMN send_stage_advanced boolean NOT NULL DEFAULT false;";
var CONTACT_MAIL_SQL = `
CREATE TABLE crm_contact_mail_events (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),
 contact_id integer NOT NULL REFERENCES contacts(id), customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
 event_key text NOT NULL CHECK(length(event_key) BETWEEN 1 AND ${CONTACT_MAIL_LIMITS.key}),
 mailbox_key text NOT NULL CHECK(length(mailbox_key) BETWEEN 1 AND ${CONTACT_MAIL_LIMITS.mailboxKey}),
 message_key text NOT NULL CHECK(length(message_key) BETWEEN 1 AND ${CONTACT_MAIL_LIMITS.key}),
 kind text NOT NULL CHECK(kind IN (${CONTACT_MAIL_KINDS.map((kind) => `'${kind}'`).join(",")})),
 direction text NOT NULL CHECK(direction IN ('inbound','outbound')), occurred_at timestamptz NOT NULL,
 subject text NOT NULL CHECK(length(subject)<=${CONTACT_MAIL_LIMITS.subject}), preview text NOT NULL CHECK(length(preview)<=${CONTACT_MAIL_LIMITS.preview}),
 from_email text NOT NULL CHECK(length(from_email) BETWEEN 1 AND ${CONTACT_MAIL_LIMITS.email}),
 to_emails jsonb NOT NULL CHECK(jsonb_typeof(to_emails)='array' AND jsonb_array_length(to_emails)<=${CONTACT_MAIL_LIMITS.recipients}),
 cc_emails jsonb NOT NULL CHECK(jsonb_typeof(cc_emails)='array' AND jsonb_array_length(cc_emails)<=${CONTACT_MAIL_LIMITS.recipients}),
 digest text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(), activity_id bigint REFERENCES crm_shared_activities(id),
 UNIQUE(actor_id,event_key), FOREIGN KEY(customer_id,contact_id) REFERENCES crm_customer_contacts(customer_id,contact_id)
);
CREATE INDEX idx_crm_contact_mail_history ON crm_contact_mail_events(customer_id,contact_id,occurred_at DESC,event_id DESC);
`;

// server/adapters/postgres/crm-lifecycle-schema.ts
var LIFECYCLE_VERSION = "022-crm-lifecycle-public";
var LIFECYCLE_SQL = `
ALTER TABLE contacts ADD COLUMN crm_deleted_at timestamptz, ADD COLUMN crm_deleted_by uuid REFERENCES public.identity_users(user_id);
ALTER TABLE companies ADD COLUMN crm_created_by uuid REFERENCES public.identity_users(user_id), ADD COLUMN crm_deleted_at timestamptz, ADD COLUMN crm_deleted_by uuid REFERENCES public.identity_users(user_id);
CREATE INDEX idx_crm_companies_creator ON companies(crm_created_by) WHERE crm_deleted_at IS NULL;
`;

// server/adapters/postgres/crm-lifecycle-repository.ts
var DETAIL_SCAN_PAGES = 100;
var CONTACT_PAGE_SIZE = 100;
var global2 = (a) => a.roles.includes("admin") && ["shared", "summary"].includes(a.scope) && a.capabilities.includes("leads.read.all");
var creator = (a, co) => global2(a) || co.createdBy === a.userId && a.capabilities.includes("leads.create") && a.capabilities.includes("leads.develop");
var createAllowed = (a) => a.capabilities.includes("leads.create") && a.capabilities.includes("leads.develop");
function contactGuard(a, scope) {
  const auth = global2(a) ? "TRUE" : `((${contactManager(a) ? "TRUE" : "FALSE"} AND c.origin='operations') OR (${a.capabilities.includes("leads.develop") ? "TRUE" : "FALSE"} AND (${CONTACT_OWNER_SQL}=$1 OR ${sharedAccessSql("$1", CONTACT_OWNER_SQL)})))`;
  const origin = scope === "personal" ? `c.origin='personal' AND ${CONTACT_OWNER_SQL}=$1` : scope === "assigned" ? `c.origin='operations' AND (${CONTACT_OWNER_SQL}=$1 OR ${sharedAccessSql("$1", CONTACT_OWNER_SQL)})` : "TRUE";
  return `ct.crm_deleted_at IS NULL AND ${auth} AND (${origin})`;
}
function projection(a, scope) {
  const count = `(SELECT count(*)::int FROM contacts ct JOIN crm_customer_contacts cc ON cc.contact_id=ct.id JOIN crm_customers c ON c.customer_id=cc.customer_id WHERE c.company_id=co.id AND ${contactGuard(a, scope)})`;
  const empty = "NOT EXISTS(SELECT 1 FROM contacts WHERE company_id=co.id) AND NOT EXISTS(SELECT 1 FROM crm_customers WHERE company_id=co.id)";
  return `co.id AS "companyId",co.name,co.customer_type AS "customerType",co.domain,co.industry,co.country,co.size,co.updated_at::text AS revision,co.created_at AS "createdAt",co.updated_at AS "updatedAt",${count} AS "contactCount",((${global2(a) ? "TRUE" : "FALSE"} OR co.crm_created_by=$1 AND ${createAllowed(a) ? "TRUE" : "FALSE"}) AND ${empty}) AS "canDelete"`;
}
function visibility(a, scope) {
  const emptyOwn = scope === "assigned" ? "FALSE" : `(co.crm_created_by=$1 AND ${a.capabilities.includes("leads.develop") ? "TRUE" : "FALSE"})`;
  const ownCustomer = scope === "all" && contactManager(a) ? `EXISTS(SELECT 1 FROM crm_customers c WHERE c.company_id=co.id AND c.origin='operations')` : "FALSE";
  return `co.crm_deleted_at IS NULL AND (${global2(a) && scope === "all" ? "TRUE" : "FALSE"} OR ${emptyOwn} OR ${ownCustomer} OR EXISTS(SELECT 1 FROM contacts ct JOIN crm_customer_contacts cc ON cc.contact_id=ct.id JOIN crm_customers c ON c.customer_id=cc.customer_id WHERE c.company_id=co.id AND ${contactGuard(a, scope)}))`;
}
function mapped4(co) {
  return { ...co, canDelete: !!co.canDelete, createdAt: new Date(co.createdAt).toISOString(), updatedAt: new Date(co.updatedAt).toISOString() };
}
async function companiesIn(c, a, q) {
  if (!global2(a) && !contactManager(a) && !a.capabilities.includes("leads.develop"))
    return failure("FORBIDDEN", "\u65E0\u516C\u53F8\u67E5\u8BE2\u6743\u9650");
  const where = `WHERE ${visibility(a, q.scope)} AND (co.name ILIKE $2 ESCAPE '!' OR co.domain ILIKE $2 ESCAPE '!')`, args = [a.userId, `%${q.search.replace(/[!%_]/g, "!$&")}%`];
  const count = await c.query(`SELECT count(*)::int AS n FROM companies co ${where}`, args);
  const rows = await c.query(`SELECT ${projection(a, q.scope)} FROM companies co ${where} ORDER BY co.updated_at DESC,co.id DESC LIMIT $3 OFFSET $4`, [...args, q.limit, q.offset]);
  return success({ items: rows.rows.map(mapped4), total: count.rows[0].n });
}
async function companyDetailIn(c, a, input) {
  const co = (await c.query(`SELECT ${projection(a, input.scope)} FROM companies co WHERE co.id=$2 AND ${visibility(a, input.scope)}`, [a.userId, input.companyId])).rows[0];
  if (!co)
    return failure("NOT_FOUND", "\u516C\u53F8\u4E0D\u5B58\u5728");
  const contacts2 = [];
  for (let page = 0; page < DETAIL_SCAN_PAGES; page++) {
    const r = await listContactsIn(c, a, { search: "", scope: input.scope, limit: CONTACT_PAGE_SIZE, offset: contacts2.length }, input.companyId);
    if (!r.ok)
      return r;
    contacts2.push(...r.data.items);
    if (contacts2.length >= r.data.total)
      return success({ company: mapped4(co), contacts: contacts2 });
  }
  return failure("UNAVAILABLE", "\u516C\u53F8\u8054\u7CFB\u4EBA\u8FC7\u591A\uFF0C\u8BF7\u5728\u8054\u7CFB\u4EBA\u5217\u8868\u7B5B\u9009\u67E5\u770B");
}
async function companyEvent(c, a, type, companyId) {
  await c.query("INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,payload,recipient_user_ids) VALUES($1,$2,'crm',1,$3,$4::uuid[])", [type, a.userId, JSON.stringify({ companyId }), [a.userId]]);
}
async function createCompanyIn(c, a, input) {
  if (!createAllowed(a))
    return failure("FORBIDDEN", "\u65E0\u516C\u53F8\u521B\u5EFA\u6743\u9650");
  return cached(c, a, "company-create", input, async () => {
    if ((await c.query("SELECT 1 FROM companies WHERE crm_created_by=$1 AND lower(btrim(name))=lower(btrim($2)) AND crm_deleted_at IS NULL", [a.userId, input.name])).rowCount)
      return failure("CONFLICT", "\u5DF2\u6709\u540C\u540D\u516C\u53F8");
    const co = (await c.query("INSERT INTO companies(name,domain,crm_created_by) VALUES($1,$2,$3) RETURNING id", [input.name, input.domain ?? null, a.userId])).rows[0];
    await companyEvent(c, a, "crm.company.created", co.id);
    return companyDetailIn(c, a, { companyId: co.id, scope: "all" });
  }, (old) => companyDetailIn(c, a, { companyId: old.company.companyId, scope: "all" }));
}
async function deleteCompanyIn(c, a, input) {
  const co = (await c.query('SELECT crm_created_by AS "createdBy",crm_deleted_at,updated_at::text AS revision FROM companies WHERE id=$1 FOR UPDATE', [input.companyId])).rows[0];
  if (!co || !creator(a, co))
    return failure("NOT_FOUND", "\u516C\u53F8\u4E0D\u5B58\u5728\u6216\u4E0D\u53EF\u5220\u9664");
  return cached(c, a, `company-delete:${input.companyId}`, input, async () => {
    if (co.crm_deleted_at || co.revision !== input.expectedRevision)
      return failure("CONFLICT", "\u516C\u53F8\u8D44\u6599\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u91CD\u8BD5");
    if ((await c.query("SELECT 1 FROM contacts WHERE company_id=$1 UNION ALL SELECT 1 FROM crm_customers WHERE company_id=$1 LIMIT 1", [input.companyId])).rowCount)
      return failure("CONFLICT", "\u516C\u53F8\u6709\u5173\u8054\u8D44\u6599\uFF0C\u4E0D\u80FD\u5220\u9664");
    await c.query("UPDATE companies SET crm_deleted_at=clock_timestamp(),crm_deleted_by=$2,updated_at=clock_timestamp() WHERE id=$1", [input.companyId, a.userId]);
    await companyEvent(c, a, "crm.company.deleted", input.companyId);
    return success({ companyId: input.companyId });
  });
}
async function deleteContactsIn(c, a, input) {
  const contacts2 = [];
  for (const ref2 of [...input.contacts].sort((x, y) => x.contactId - y.contactId)) {
    const ct = await contact(c, ref2, true, true);
    if (!ct || !read(a, ct) || !canDeleteContact(a, ct))
      return failure("FORBIDDEN", "\u6240\u9009\u8054\u7CFB\u4EBA\u4E0D\u53EF\u5220\u9664\uFF1B\u5206\u914D\u7EBF\u7D22\u987B\u7531\u6765\u6E90\u7BA1\u7406\u5458\u5904\u7406\uFF0C\u5F85\u63A5\u53D7\u8BF7\u6C42\u987B\u5148\u64A4\u56DE");
    contacts2.push(ct);
  }
  return cached(c, a, "contact-delete", input, async () => {
    for (const ct of contacts2) {
      const expected = input.contacts.find((r) => r.contactId === ct.contactId).expectedVersion;
      const state = (await c.query("SELECT crm_deleted_at FROM contacts WHERE id=$1", [ct.contactId])).rows[0];
      if (state.crm_deleted_at || ct.contactVersion !== expected)
        return failure("CONFLICT", "\u8054\u7CFB\u4EBA\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u91CD\u9009");
    }
    const deleted = [];
    for (const ct of contacts2) {
      const version3 = ct.contactVersion + 1;
      await c.query("UPDATE contacts SET crm_deleted_at=clock_timestamp(),crm_deleted_by=$2,crm_contact_version=$3,updated_at=clock_timestamp() WHERE id=$1", [ct.contactId, a.userId, version3]);
      await contactEvent(c, a, ct, "crm.contact.deleted", version3);
      deleted.push({ contactId: ct.contactId, customerId: ct.customerId, contactVersion: version3 });
    }
    return success({ deleted });
  });
}

// server/adapters/postgres/lead-repository.ts
async function authorizeLeadActor(c, hash) {
  const r = await c.query(`SELECT u.user_id AS "userId",a.scope,a.capabilities,
 ARRAY(SELECT g.role FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active ORDER BY role) AS roles
 FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) JOIN public.identity_product_access a ON a.user_id=u.user_id AND a.product_id='crm' AND a.active
 WHERE s.token_hash=$1 AND s.client='api' AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND NOT u.must_change_password AND s.security_revision=u.security_revision`, [hash]);
  const a = r.rows[0];
  if (!a || !a.roles.length)
    return null;
  return { ...a, capabilities: effectiveCapabilitiesFor(a.roles, a.capabilities) };
}
function administrator(a) {
  return a.roles.includes("admin") && ["shared", "summary"].includes(a.scope) && a.capabilities.includes("leads.read.all");
}
function canReadLead(a, c) {
  return administrator(a) || operational(a) && c.origin === "operations" || c.owner_user_id === a.userId && a.capabilities.includes("leads.develop");
}
function canAssign(a, c) {
  return !c.development_restriction?.trim() && a.capabilities.includes("leads.assign") && (operational(a) || administrator(a)) && c.origin === "operations" && c.owner_user_id === null && ["draft", "published"].includes(c.state);
}
function canDevelop(a, c) {
  return a.capabilities.includes("leads.develop") && (administrator(a) || c.owner_user_id === a.userId || operational(a) && c.origin === "operations" && c.owner_user_id === null && ["draft", "published"].includes(c.state));
}
function operationsOrigin(a) {
  return a.roles.some((role) => role === "operations" || role === "admin");
}
function operational(a) {
  return a.roles.includes("operations") && ["shared", "summary"].includes(a.scope) && (a.capabilities.includes("followups.read") || a.capabilities.includes("leads.import") || a.capabilities.includes("leads.publish") || a.capabilities.includes("leads.assign"));
}
var STAGE_PROJECTION = "c.relationship_stage";
var CONTACTED_PREDICATE = "EXISTS(SELECT 1 FROM contacts ct JOIN crm_customer_contacts cx ON cx.contact_id=ct.id WHERE cx.customer_id=c.customer_id AND ct.crm_deleted_at IS NULL AND ct.crm_touch_status IN ('contacted','replied','bounced','autoreply'))";
var BOARD_STAGE_PROJECTION = "CASE WHEN c.relationship_stage='cold' THEN 'reaching' ELSE c.relationship_stage END";
var PREVIEW = `c.customer_id AS "customerId",co.name AS "companyName",co.country,c.state,c.version,c.origin,(SELECT ct.first_name FROM contacts ct JOIN crm_customer_contacts cx ON cx.contact_id=ct.id WHERE cx.customer_id=c.customer_id AND ct.crm_deleted_at IS NULL ORDER BY ct.id LIMIT 1) AS "primaryContactName",(SELECT ct.email FROM contacts ct JOIN crm_customer_contacts cx ON cx.contact_id=ct.id WHERE cx.customer_id=c.customer_id AND ct.crm_deleted_at IS NULL ORDER BY ct.id LIMIT 1) AS "primaryContactEmail",c.owner_user_id AS "ownerUserId",c.source,${STAGE_PROJECTION} AS stage,${CONTACTED_PREDICATE} AS "hasContacted",(SELECT u.display_name FROM public.identity_users u WHERE u.user_id=c.owner_user_id) AS "ownerName",(SELECT max(act.occurred_at) FROM crm_shared_activities act WHERE act.customer_id=c.customer_id AND act.method NOT IN ('legacy','note')) AS "recentActivityAt",(SELECT count(*)::int FROM crm_customer_contacts cc JOIN contacts cct ON cct.id=cc.contact_id WHERE cc.customer_id=c.customer_id AND cct.crm_deleted_at IS NULL) AS "contactCount"`;
var PostgresLeadRepository = class {
  constructor(pool, log) {
    this.pool = pool;
    this.log = log;
    assertCenterDatabasePool(pool);
  }
  async tx(action) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await action(c);
      await c.query(r.ok ? "COMMIT" : "ROLLBACK");
      return r;
    } catch (error) {
      try {
        await c.query("ROLLBACK");
      } catch {
        this.log.write("ERROR", "leads.rollback", "\u56DE\u6EDA\u5931\u8D25");
      }
      const code2 = error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN";
      this.log.write("ERROR", "leads.pg", `\u64CD\u4F5C\u5931\u8D25 code=${code2}`);
      return failure("DATABASE_ERROR", "\u7EBF\u7D22\u670D\u52A1\u6682\u4E0D\u53EF\u7528");
    } finally {
      c.release();
    }
  }
  migrate() {
    return this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock($1)", [LEAD_LOCK]);
      const hash = (0, import_node_crypto13.createHash)("sha256").update(LEAD_SQL).digest("hex");
      const old = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [LEAD_VERSION]);
      if (old.rows.length && old.rows[0].checksum !== hash)
        return failure("CONFLICT", "\u7EBF\u7D22\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!old.rows.length) {
        await c.query(LEAD_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [LEAD_VERSION, hash]);
      }
      const nextHash = (0, import_node_crypto13.createHash)("sha256").update(CUSTOMER_SQL).digest("hex");
      const next = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [CUSTOMER_VERSION]);
      if (next.rows.length && next.rows[0].checksum !== nextHash)
        return failure("CONFLICT", "\u5BA2\u6237\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!next.rows.length) {
        await c.query(CUSTOMER_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [CUSTOMER_VERSION, nextHash]);
      }
      const profileHash = (0, import_node_crypto13.createHash)("sha256").update(CUSTOMER_PROFILE_SQL).digest("hex");
      const profile2 = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [CUSTOMER_PROFILE_VERSION]);
      if (profile2.rows.length && profile2.rows[0].checksum !== profileHash)
        return failure("CONFLICT", "\u5BA2\u6237\u4E3B\u6863\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!profile2.rows.length) {
        await c.query(CUSTOMER_PROFILE_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [CUSTOMER_PROFILE_VERSION, profileHash]);
      }
      const followupHash = (0, import_node_crypto13.createHash)("sha256").update(FOLLOWUP_SQL).digest("hex");
      const followup = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [FOLLOWUP_VERSION]);
      if (followup.rows.length && followup.rows[0].checksum !== followupHash)
        return failure("CONFLICT", "\u5BA2\u6237\u8DDF\u8FDB\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!followup.rows.length) {
        await c.query(FOLLOWUP_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [FOLLOWUP_VERSION, followupHash]);
      }
      const contactHash = (0, import_node_crypto13.createHash)("sha256").update(CONTACT_ASSIGNMENT_SQL).digest("hex");
      const contactOld = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [CONTACT_ASSIGNMENT_VERSION]);
      if (contactOld.rows.length && contactOld.rows[0].checksum !== contactHash)
        return failure("CONFLICT", "\u8054\u7CFB\u4EBA\u5206\u914D\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!contactOld.rows.length) {
        await c.query(CONTACT_ASSIGNMENT_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [CONTACT_ASSIGNMENT_VERSION, contactHash]);
      }
      const mailHash = (0, import_node_crypto13.createHash)("sha256").update(CONTACT_MAIL_SQL).digest("hex");
      const mailOld = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [CONTACT_MAIL_VERSION]);
      if (mailOld.rows.length && mailOld.rows[0].checksum !== mailHash)
        return failure("CONFLICT", "\u90AE\u4EF6\u4E8B\u4EF6\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!mailOld.rows.length) {
        await c.query(CONTACT_MAIL_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [CONTACT_MAIL_VERSION, mailHash]);
      }
      const sendStageHash = (0, import_node_crypto13.createHash)("sha256").update(CONTACT_MAIL_SEND_STAGE_SQL).digest("hex");
      const sendStageOld = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [CONTACT_MAIL_SEND_STAGE_VERSION]);
      if (sendStageOld.rows.length && sendStageOld.rows[0].checksum !== sendStageHash)
        return failure("CONFLICT", "\u53D1\u9001\u8F6E\u6B21\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!sendStageOld.rows.length) {
        await c.query(CONTACT_MAIL_SEND_STAGE_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [CONTACT_MAIL_SEND_STAGE_VERSION, sendStageHash]);
      }
      const lifecycleHash = (0, import_node_crypto13.createHash)("sha256").update(LIFECYCLE_SQL).digest("hex");
      const lifecycleOld = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [LIFECYCLE_VERSION]);
      if (lifecycleOld.rows.length && lifecycleOld.rows[0].checksum !== lifecycleHash)
        return failure("CONFLICT", "\u751F\u547D\u5468\u671F\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!lifecycleOld.rows.length) {
        await c.query(LIFECYCLE_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [LIFECYCLE_VERSION, lifecycleHash]);
      }
      const shareHash = (0, import_node_crypto13.createHash)("sha256").update(CONTACT_SHARING_SQL).digest("hex");
      const shareOld = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [CONTACT_SHARING_VERSION]);
      if (shareOld.rows.length && shareOld.rows[0].checksum !== shareHash)
        return failure("CONFLICT", "\u5171\u4EAB\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!shareOld.rows.length) {
        await c.query(CONTACT_SHARING_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [CONTACT_SHARING_VERSION, shareHash]);
      }
      const correctionHash = (0, import_node_crypto13.createHash)("sha256").update(MAIL_CORRECTION_SQL).digest("hex");
      const correctionOld = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [MAIL_CORRECTION_VERSION]);
      if (correctionOld.rows.length && correctionOld.rows[0].checksum !== correctionHash)
        return failure("CONFLICT", "\u90AE\u4EF6\u66F4\u6B63\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!correctionOld.rows.length) {
        await c.query(MAIL_CORRECTION_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [MAIL_CORRECTION_VERSION, correctionHash]);
      }
      const acceptanceHash = (0, import_node_crypto13.createHash)("sha256").update(SEND_ACCEPTANCE_SQL).digest("hex");
      const acceptanceOld = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [SEND_ACCEPTANCE_VERSION]);
      if (acceptanceOld.rows.length && acceptanceOld.rows[0].checksum !== acceptanceHash)
        return failure("CONFLICT", "\u53D1\u9001\u5F52\u6863\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!acceptanceOld.rows.length) {
        await c.query(SEND_ACCEPTANCE_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [SEND_ACCEPTANCE_VERSION, acceptanceHash]);
      }
      const extensionHash = (0, import_node_crypto13.createHash)("sha256").update(LEAD_FIELD_EXTENSION_SQL).digest("hex");
      const extension = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [LEAD_FIELD_EXTENSION_VERSION]);
      if (extension.rows.length && extension.rows[0].checksum !== extensionHash)
        return failure("CONFLICT", "\u7EBF\u7D22\u5B57\u6BB5\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!extension.rows.length) {
        await c.query(LEAD_FIELD_EXTENSION_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [LEAD_FIELD_EXTENSION_VERSION, extensionHash]);
      }
      const touchHash = (0, import_node_crypto13.createHash)("sha256").update(CONTACT_TOUCH_STATUS_SQL).digest("hex");
      const touchOld = await c.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [CONTACT_TOUCH_STATUS_VERSION]);
      if (touchOld.rows.length && touchOld.rows[0].checksum !== touchHash)
        return failure("CONFLICT", "\u8054\u7CFB\u72B6\u6001\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!touchOld.rows.length) {
        await c.query(CONTACT_TOUCH_STATUS_SQL);
        await c.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [CONTACT_TOUCH_STATUS_VERSION, touchHash]);
      }
      return success(void 0);
    });
  }
  authorizeSend(hash, input) {
    return this.authorized(hash, (c, a) => authorizeSendIn(c, a, input));
  }
  acceptSend(hash, input) {
    return this.authorized(hash, (c, a) => acceptSendIn(c, a, input));
  }
  shares(hash, input) {
    return this.authorized(hash, (c, a) => sharesIn(c, a, input));
  }
  createShare(hash, input) {
    return this.authorized(hash, (c, a) => createShareIn(c, a, input));
  }
  decideShare(hash, action, input) {
    return this.authorized(hash, (c, a) => decideShareIn(c, a, action, input));
  }
  updateShare(hash, input) {
    return this.authorized(hash, (c, a) => updateShareIn(c, a, input));
  }
  shareMembers(hash) {
    return this.authorized(hash, (c, a) => shareMembersIn(c, a));
  }
  deleteContacts(hash, input) {
    return this.authorized(hash, (c, a) => deleteContactsIn(c, a, input));
  }
  createCompany(hash, input) {
    return this.authorized(hash, (c, a) => createCompanyIn(c, a, input));
  }
  deleteCompany(hash, input) {
    return this.authorized(hash, (c, a) => deleteCompanyIn(c, a, input));
  }
  companies(hash, input) {
    return this.authorized(hash, (c, a) => companiesIn(c, a, input));
  }
  companyDetail(hash, input) {
    return this.authorized(hash, (c, a) => companyDetailIn(c, a, input));
  }
  authorized(hash, action) {
    return this.tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK]);
      await c.query("SELECT pg_advisory_xact_lock($1)", [LEAD_LOCK]);
      const a = await authorizeLeadActor(c, hash);
      return a ? action(c, a) : failure("UNAUTHORIZED", "CRM\u4F1A\u8BDD\u6216\u4EA7\u54C1\u51C6\u5165\u5DF2\u5931\u6548");
    });
  }
  async cached(c, a, operation, input, action) {
    const digest = (0, import_node_crypto13.createHash)("sha256").update(JSON.stringify(input)).digest("hex");
    const old = await c.query("SELECT digest,response FROM crm_lead_idempotency WHERE actor_id=$1 AND operation=$2 AND key=$3", [a.userId, operation, input.idempotencyKey]);
    if (old.rows.length) {
      if (old.rows[0].digest !== digest)
        return failure("CONFLICT", "\u5E42\u7B49\u952E\u5DF2\u7528\u4E8E\u4E0D\u540C\u8BF7\u6C42");
      if (operation.startsWith("assign:")) {
        const current = await this.detailIn(c, a, operation.split(":")[1]);
        if (!current.ok)
          return current;
        if (current.data.ownerUserId !== input.salesUserId || current.data.state !== "owned")
          return failure("CONFLICT", "\u5BA2\u6237\u5F52\u5C5E\u5DF2\u53D8\u5316");
        return current;
      }
      if (operation.startsWith("claim:") || operation.startsWith("followup:") || operation.startsWith("update:"))
        return this.detailIn(c, a, operation.split(":")[1]);
      if (operation === "create")
        return this.detailIn(c, a, old.rows[0].response.customerId);
      return success(old.rows[0].response);
    }
    const result2 = await action();
    if (result2.ok)
      await c.query("INSERT INTO crm_lead_idempotency(actor_id,operation,key,digest,response) VALUES($1,$2,$3,$4,$5)", [a.userId, operation, input.idempotencyKey, digest, JSON.stringify(result2.data)]);
    return result2;
  }
  async event(c, a, id, version3, type, activityId) {
    await c.query("INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload) VALUES($1,$2,$3,$4,$5,$6)", [type, a.userId, "crm", version3, id, JSON.stringify({ customerId: id, version: version3, ...activityId ? { activityId } : {} })]);
  }
  createCustomer(hash, input) {
    return this.authorized(hash, async (c, a) => {
      if (!a.capabilities.includes("leads.create") || !a.capabilities.includes("leads.develop"))
        return failure("FORBIDDEN", "\u65E0\u5BA2\u6237\u521B\u5EFA\u6743\u9650");
      return this.cached(c, a, "create", input, async () => {
        const emails = input.contacts.map((x) => x.email.trim().toLowerCase()).filter(Boolean);
        const collision = await c.query("SELECT 1 FROM contacts WHERE email=ANY($1::text[]) LIMIT 1", [emails]);
        if (collision.rows.length)
          return failure("CONFLICT", "\u8054\u7CFB\u4EBA\u4FE1\u606F\u51B2\u7A81\uFF0C\u8BF7\u6838\u5B9E\u6765\u6E90");
        const company = await c.query("INSERT INTO companies(name,country,customer_type,industry) VALUES($1,$2,$3,$4) RETURNING id", [input.companyName.trim(), input.country ?? null, input.customerType?.trim() || null, input.businessType?.trim() || null]);
        const id = (0, import_node_crypto13.randomUUID)();
        await c.query("INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin,state,owner_user_id) VALUES($1::uuid,$2,$3,$1::uuid::text,$4,$5,$6,$7,$8)", [id, company.rows[0].id, input.source, input.sourceDetail, a.userId, operationsOrigin(a) ? "operations" : "personal", operationsOrigin(a) ? "draft" : "owned", operationsOrigin(a) ? null : a.userId]);
        for (const contact2 of input.contacts) {
          const row2 = await c.query("INSERT INTO contacts(email,company_id,first_name,country,phone,whatsapp,title,source,source_detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id", [contact2.email.trim().toLowerCase() || null, company.rows[0].id, contact2.name ?? null, contact2.country ?? null, contact2.phone ?? null, contact2.whatsapp ?? null, contact2.title ?? null, input.source, input.sourceDetail]);
          await c.query("INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)", [id, row2.rows[0].id]);
        }
        await c.query("UPDATE crm_customers SET business_type=$2,development_restriction=$3,source_created_at=$4 WHERE customer_id=$1", [id, input.businessType?.trim() || null, input.developmentRestriction?.trim() || null, input.sourceCreatedAt ? normalizeSourceDate(input.sourceCreatedAt) : null]);
        await this.event(c, a, id, 1, "crm.customer.created");
        return this.detailIn(c, a, id);
      });
    });
  }
  updateCustomer(hash, input) {
    return this.authorized(hash, async (c, a) => {
      if (!a.capabilities.includes("leads.develop"))
        return failure("FORBIDDEN", "\u65E0\u5BA2\u6237\u4FEE\u6539\u6743\u9650");
      const rows = await c.query("SELECT * FROM crm_customers WHERE customer_id=$1 FOR UPDATE", [input.customerId]);
      const customer2 = rows.rows[0];
      if ((await c.query("SELECT 1 FROM crm_contact_assignment_requests WHERE customer_id=$1 AND status IN ('pending','accepted') LIMIT 1", [input.customerId])).rows.length)
        return failure("CONFLICT", "\u5BA2\u6237\u542B\u72EC\u7ACB\u5206\u914D\u8054\u7CFB\u4EBA\uFF0C\u8BF7\u4F7F\u7528\u8054\u7CFB\u4EBA\u4FEE\u6539");
      if (!customer2 || !canDevelop(a, customer2))
        return failure("NOT_FOUND", "\u5BA2\u6237\u4E0D\u5B58\u5728");
      if (customer2.origin === "operations" && !administrator(a) && !operational(a))
        return failure("FORBIDDEN", "\u5206\u914D\u7EBF\u7D22\u8BF7\u4F7F\u7528\u8054\u7CFB\u4EBA\u5B57\u6BB5\u4FEE\u6539");
      return this.cached(c, a, `update:${input.customerId}`, input, async () => {
        if (customer2.version !== input.expectedVersion)
          return failure("CONFLICT", "\u5BA2\u6237\u7248\u672C\u5DF2\u53D8\u5316");
        const existing = await c.query("SELECT co.id,co.email FROM contacts co JOIN crm_customer_contacts cc ON cc.contact_id=co.id WHERE cc.customer_id=$1 AND co.crm_deleted_at IS NULL", [input.customerId]);
        const ids = input.contacts.filter((x) => x.contactId !== void 0).map((x) => x.contactId);
        if (new Set(ids).size !== ids.length || ids.some((id) => !existing.rows.some((x) => x.id === id)) || existing.rows.some((x) => !ids.includes(x.id)))
          return failure("CONFLICT", "\u5DF2\u6709\u8054\u7CFB\u4EBA\u5FC5\u987B\u643A\u5E26\u539F\u7F16\u53F7\u5E76\u5168\u90E8\u4FDD\u7559");
        const emails = input.contacts.map((x) => x.email.trim().toLowerCase()).filter(Boolean);
        const collision = await c.query("SELECT id,email FROM contacts WHERE email=ANY($1::text[]) AND crm_deleted_at IS NULL", [emails]);
        if (collision.rows.some((x) => !input.contacts.some((v) => v.contactId === x.id && v.email.trim().toLowerCase() === x.email)))
          return failure("CONFLICT", "\u8054\u7CFB\u4EBA\u4FE1\u606F\u51B2\u7A81\uFF0C\u8BF7\u6838\u5B9E\u6765\u6E90");
        const deletedEmail = input.contacts.find((x) => x.contactId === void 0 && x.email.trim())?.email.trim().toLowerCase();
        if (deletedEmail && (await c.query("SELECT 1 FROM contacts WHERE email=$1 AND crm_deleted_at IS NOT NULL", [deletedEmail])).rows.length)
          return failure("CONFLICT", "\u8BE5\u90AE\u7BB1\u5C5E\u4E8E\u5DF2\u5220\u9664\u8054\u7CFB\u4EBA\uFF0C\u8BF7\u5728\u8054\u7CFB\u4EBA\u65B0\u589E\u4E2D\u6062\u590D");
        await c.query("UPDATE companies SET name=$2,country=$3,updated_at=now() WHERE id=$1", [customer2.company_id, input.companyName.trim(), input.country ?? null]);
        for (const contact2 of input.contacts) {
          const values = [contact2.email.trim().toLowerCase() || null, contact2.name ?? null, contact2.country ?? null, contact2.phone ?? null, contact2.whatsapp ?? null, contact2.title ?? null];
          if (contact2.contactId !== void 0)
            await c.query("UPDATE contacts SET email=$1,first_name=$2,country=$3,phone=$4,whatsapp=$5,title=$6,crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$7", [...values, contact2.contactId]);
          else {
            const row2 = await c.query("INSERT INTO contacts(email,first_name,country,phone,whatsapp,title,company_id,source,source_detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id", [...values, customer2.company_id, customer2.source, customer2.source_detail]);
            await c.query("INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)", [input.customerId, row2.rows[0].id]);
          }
        }
        await c.query("UPDATE companies SET customer_type=CASE WHEN $2 THEN $3 ELSE customer_type END,industry=CASE WHEN $4 THEN $5 ELSE industry END,updated_at=now() WHERE id=$1", [customer2.company_id, input.customerType !== void 0, input.customerType?.trim() || null, input.businessType !== void 0, input.businessType?.trim() || null]);
        await c.query("UPDATE crm_customers SET business_type=CASE WHEN $2 THEN $3 ELSE business_type END,development_restriction=CASE WHEN $4 THEN $5 ELSE development_restriction END,source_created_at=CASE WHEN $6 THEN $7::timestamptz ELSE source_created_at END,version=version+1 WHERE customer_id=$1", [input.customerId, input.businessType !== void 0, input.businessType?.trim() || null, input.developmentRestriction !== void 0, input.developmentRestriction?.trim() || null, input.sourceCreatedAt !== void 0, input.sourceCreatedAt ? normalizeSourceDate(input.sourceCreatedAt) : null]);
        await this.event(c, a, input.customerId, input.expectedVersion + 1, "crm.customer.updated");
        return this.detailIn(c, a, input.customerId);
      });
    });
  }
  async memberRows(c) {
    const rows = await c.query(`SELECT u.user_id AS "userId",u.display_name AS "displayName",pa.scope,pa.capabilities,ARRAY(SELECT g.role FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active ORDER BY g.role) AS roles FROM public.identity_users u JOIN public.identity_product_access pa ON pa.user_id=u.user_id AND pa.product_id='crm' AND pa.active WHERE u.active AND NOT u.must_change_password ORDER BY u.display_name,u.user_id FOR SHARE OF u,pa`);
    return rows.rows.filter((x) => x.roles.length).map((x) => ({ ...x, capabilities: effectiveCapabilitiesFor(x.roles, x.capabilities) })).filter((x) => x.capabilities.length);
  }
  members(hash, q) {
    return this.authorized(hash, async (c, a) => {
      if (!a.capabilities.includes("members.read") || !a.capabilities.includes("leads.assign") || !(operational(a) || administrator(a)))
        return failure("FORBIDDEN", "\u65E0\u5206\u914D\u6210\u5458\u76EE\u5F55\u6743\u9650");
      const rows = (await this.memberRows(c)).filter((x) => x.displayName.toLocaleLowerCase().includes(q.search.toLocaleLowerCase()));
      return success({ items: rows.slice(q.offset, q.offset + q.limit).map((x) => ({ userId: x.userId, displayName: x.displayName, assignable: isContactAssignmentTarget(x, a.userId) })), total: rows.length });
    });
  }
  assign(hash, _input) {
    return this.authorized(hash, async () => failure("CONFLICT", "\u8BF7\u4F7F\u7528\u8054\u7CFB\u4EBA\u5206\u914D\u8BF7\u6C42\u5E76\u7B49\u5F85\u63A5\u6536"));
  }
  bootstrap(hash) {
    return this.authorized(hash, async (c, a) => {
      const counts = await c.query(`SELECT count(*) FILTER(WHERE state='published')::int AS pool,count(*) FILTER(WHERE owner_user_id=$1)::int AS mine FROM crm_customers`, [a.userId]);
      const head = await c.query("SELECT COALESCE((SELECT delivery_seq FROM crm_feed_heads WHERE user_id=$1),0)::text AS cursor", [a.userId]);
      return success({ userId: a.userId, capabilities: a.capabilities, scope: a.scope, summary: { pool: a.capabilities.includes("leads.claim") ? counts.rows[0].pool : 0, mine: a.capabilities.includes("leads.develop") ? counts.rows[0].mine : 0 }, feedCursor: head.rows[0].cursor });
    });
  }
  importWorkbook(hash, input) {
    return this.authorized(hash, async (c, a) => {
      const personal = !operationsOrigin(a);
      input = { ...input, kind: personal ? "personal" : "operations" };
      if (personal ? !a.capabilities.includes("leads.create") || !a.capabilities.includes("leads.develop") : !administrator(a) && (!a.capabilities.includes("leads.import") || !operational(a)))
        return failure("FORBIDDEN", "\u65E0\u5BFC\u5165\u6743\u9650\u6216\u6765\u6E90\u7BA1\u7406\u8303\u56F4");
      return this.cached(c, a, "workbook-import", input, () => importWorkbookIn(c, a, input));
    });
  }
  importRows(hash, input) {
    return this.authorized(hash, async (c, a) => {
      const personal = !operationsOrigin(a);
      input = { ...input, kind: personal ? "personal" : "operations", source: input.companyMatching && personal ? `${input.source}:${a.userId}` : input.source };
      if (personal ? !a.capabilities.includes("leads.create") || !a.capabilities.includes("leads.develop") : !administrator(a) && (!a.capabilities.includes("leads.import") || !operational(a)))
        return failure("FORBIDDEN", "\u65E0\u5BFC\u5165\u6743\u9650\u6216\u6765\u6E90\u7BA1\u7406\u8303\u56F4");
      return this.cached(c, a, "import", input, async () => success(await importFlatLeadsIn(c, a, input)));
    });
  }
  publish(hash, batchId, input) {
    return this.authorized(hash, async (c, a) => {
      if (!a.capabilities.includes("leads.publish") || !operational(a))
        return failure("FORBIDDEN", "\u65E0\u53D1\u5E03\u6743\u9650");
      const batch = await c.query("SELECT * FROM crm_import_batches WHERE batch_id=$1 FOR UPDATE", [batchId]);
      if (!batch.rows.length || batch.rows[0].actor_id !== a.userId)
        return failure("NOT_FOUND", "\u6279\u6B21\u4E0D\u5B58\u5728");
      return this.cached(c, a, `publish:${batchId}`, input, async () => {
        if (batch.rows[0].version !== input.expectedVersion)
          return failure("CONFLICT", "\u6279\u6B21\u7248\u672C\u5DF2\u53D8\u5316");
        const rows = await c.query(`SELECT row_id,customer_id,status FROM crm_import_rows WHERE batch_id=$1 AND row_id=ANY($2::uuid[])`, [batchId, input.rowIds]);
        if (rows.rows.length !== new Set(input.rowIds).size || rows.rows.some((r) => !r.customer_id || !["created", "appended", "duplicate"].includes(r.status)))
          return failure("CONFLICT", "\u4EC5\u6709\u6548\u6765\u6E90\u884C\u53EF\u4EE5\u53D1\u5E03");
        const ids = [...new Set(rows.rows.map((r) => r.customer_id))];
        for (const id of ids) {
          const update = await c.query(`UPDATE crm_customers SET state='published',version=version+1 WHERE customer_id=$1 AND state='draft' AND origin='operations' AND created_by=$2 AND COALESCE(btrim(development_restriction),'')='' RETURNING version`, [id, a.userId]);
          if (!update.rows.length)
            return failure("CONFLICT", "\u5BA2\u6237\u72B6\u6001\u5DF2\u53D8\u5316\u6216\u5B58\u5728\u5F00\u53D1\u9650\u5236");
          await this.event(c, a, id, update.rows[0].version, "crm.lead.published");
        }
        await c.query("UPDATE crm_import_batches SET version=version+1 WHERE batch_id=$1", [batchId]);
        return success({ batchId, version: input.expectedVersion + 1, publishedCustomerIds: ids });
      });
    });
  }
  listContacts(hash, q) {
    return this.authorized(hash, (c, a) => listContactsIn(c, a, q));
  }
  listContactGroups(hash, q) {
    return this.authorized(hash, (c, a) => listContactGroupsIn(c, a, q));
  }
  recordContactMailEvent(hash, input) {
    return this.authorized(hash, (c, a) => recordContactMailEventIn(c, a, input));
  }
  contactDetail(hash, input) {
    return this.authorized(hash, (c, a) => contactDetailIn(c, a, input));
  }
  companyUpdate(hash, input) {
    return this.authorized(hash, (c, a) => companyUpdateIn(c, a, input));
  }
  contactUpdate(hash, input) {
    return this.authorized(hash, (c, a) => contactUpdateIn(c, a, input));
  }
  contactFollowup(hash, input) {
    return this.authorized(hash, (c, a) => contactFollowupIn(c, a, input));
  }
  contactAssignments(hash, input) {
    return this.authorized(hash, (c, a) => contactAssignmentsIn(c, a, input));
  }
  contactAssignmentGroups(hash, input) {
    return this.authorized(hash, (c, a) => contactAssignmentGroupsIn(c, a, input));
  }
  createContactAssignments(hash, input) {
    return this.authorized(hash, (c, a) => createContactAssignmentsIn(c, a, input));
  }
  decideContactAssignment(hash, action, input) {
    return this.authorized(hash, (c, a) => decideContactAssignmentIn(c, a, action, input));
  }
  decideContactAssignmentGroup(hash, action, input) {
    return this.authorized(hash, (c, a) => decideContactAssignmentGroupIn(c, a, action, input));
  }
  list(hash, q) {
    return this.authorized(hash, async (c, a) => {
      if (q.view === "all" && !administrator(a) || q.view === "operations" && !operational(a) || q.view === "pool" && !a.capabilities.includes("leads.claim") || ["mine", "personal", "assigned"].includes(q.view) && !a.capabilities.includes("leads.develop"))
        return failure("FORBIDDEN", "\u65E0\u5217\u8868\u6743\u9650");
      const where = q.view === "all" ? "($1::uuid IS NOT NULL)" : q.view === "operations" ? "($1::uuid IS NOT NULL) AND c.origin='operations'" : q.view === "pool" ? `($1::uuid IS NOT NULL) AND c.state='published'` : q.view === "personal" ? `c.owner_user_id=$1 AND c.origin='personal'` : q.view === "assigned" ? `c.owner_user_id=$1 AND c.origin='operations'` : `c.owner_user_id=$1`;
      const filter = `WHERE ${where} AND (co.name ILIKE $2 ESCAPE '!' ${q.view === "pool" ? "" : "OR EXISTS(SELECT 1 FROM contacts ct JOIN crm_customer_contacts cx ON cx.contact_id=ct.id WHERE cx.customer_id=c.customer_id AND ct.crm_deleted_at IS NULL AND (ct.email ILIKE $2 ESCAPE '!' OR ct.first_name ILIKE $2 ESCAPE '!'))"}) AND ($3::text IS NULL OR ($3='assigned' AND c.owner_user_id IS NOT NULL) OR ($3='unassigned' AND c.owner_user_id IS NULL AND c.state IN ('draft','published'))) AND ($4::text IS NULL OR ${q.followupOnly ? BOARD_STAGE_PROJECTION : STAGE_PROJECTION}=$4)${q.followupOnly ? ` AND ${CONTACTED_PREDICATE}` : ""}`;
      const p = [a.userId, `%${q.search.replace(/[!%_]/g, "!$&")}%`, q.assignment ?? null, q.stage ?? null];
      const count = await c.query(`SELECT count(*)::int AS n FROM crm_customers c JOIN companies co ON co.id=c.company_id ${filter}`, p);
      const items = await c.query(`SELECT ${PREVIEW} FROM crm_customers c JOIN companies co ON co.id=c.company_id ${filter} ORDER BY c.created_at DESC,c.customer_id LIMIT $5 OFFSET $6`, [...p, q.limit, q.offset]);
      for (const item of items.rows)
        if (item.recentActivityAt)
          item.recentActivityAt = item.recentActivityAt.toISOString();
      if (q.view === "pool")
        for (const item of items.rows) {
          delete item.source;
          delete item.ownerUserId;
          delete item.ownerName;
          delete item.recentActivityAt;
          delete item.stage;
          delete item.hasContacted;
          delete item.primaryContactName;
          delete item.primaryContactEmail;
        }
      return success({ items: items.rows, total: count.rows[0].n });
    });
  }
  async detailIn(c, a, id) {
    const r = await c.query(`SELECT ${PREVIEW},c.source,c.source_detail AS "sourceDetail",c.customer_key AS "customerKey",c.owner_user_id AS "ownerUserId",c.owner_user_id,c.created_by,c.development_restriction,COALESCE(co.customer_type,'') AS "customerType",COALESCE(co.industry,c.business_type,'') AS "businessType",COALESCE(c.development_restriction,'') AS "developmentRestriction",c.source_created_at AS "sourceCreatedAt",c.stage_needs_review AS "stageNeedsReview" FROM crm_customers c JOIN companies co ON co.id=c.company_id WHERE c.customer_id=$1`, [id]);
    const v = r.rows[0];
    if (v?.recentActivityAt)
      v.recentActivityAt = v.recentActivityAt.toISOString();
    if (v && !canReadLead(a, v) && a.capabilities.includes("leads.claim") && (v.state === "published" || v.owner_user_id === a.userId)) {
      return success({ customerId: v.customerId, companyName: v.companyName, country: v.country, state: v.state, version: v.version, contactCount: v.contactCount, source: "", sourceDetail: "", customerKey: "", ownerUserId: null, canEdit: false, canFollowup: false, contacts: [], activities: [] });
    }
    if (!v || !canReadLead(a, v))
      return failure("NOT_FOUND", "\u5BA2\u6237\u4E0D\u5B58\u5728");
    if (!administrator(a) && !(operational(a) && v.origin === "operations") && (await c.query("SELECT 1 FROM crm_contact_assignment_requests WHERE customer_id=$1 AND status='accepted' AND target_user_id<>$2 LIMIT 1", [id, a.userId])).rows.length)
      return failure("NOT_FOUND", "\u8BF7\u4F7F\u7528\u8054\u7CFB\u4EBA\u8BE6\u60C5");
    const contacts2 = await c.query(`SELECT co.id AS "contactId",COALESCE(co.email,'') AS email,co.first_name AS name,co.country,co.phone,co.whatsapp,co.title,co.crm_touch_status AS "touchStatus" FROM contacts co JOIN crm_customer_contacts cc ON cc.contact_id=co.id WHERE cc.customer_id=$1 AND co.crm_deleted_at IS NULL ORDER BY co.id`, [id]);
    const feedbackAllowed = administrator(a) || operational(a) && v.origin === "operations" && a.capabilities.includes("followups.read") || v.owner_user_id === a.userId && a.capabilities.includes("leads.develop");
    const activities = feedbackAllowed ? await c.query(`SELECT act.id::text,act.actor_id AS "actorId",u.display_name AS "actorName",act.note,act.stage,act.created_at AS "createdAt",act.method,act.occurred_at AS "occurredAt",act.recorded_at AS "recordedAt",act.contact_id AS "contactId",ct.first_name AS "contactName",act.contact_status AS "contactStatus",act.opportunity_id AS "opportunityId",op.title AS "opportunityTitle" FROM crm_shared_activities act LEFT JOIN public.identity_users u ON u.user_id=act.actor_id LEFT JOIN contacts ct ON ct.id=act.contact_id LEFT JOIN crm_opportunities op ON op.opportunity_id=act.opportunity_id AND op.customer_id=act.customer_id WHERE act.customer_id=$1 ORDER BY act.occurred_at DESC,act.id DESC`, [id]) : { rows: [] };
    if (v.sourceCreatedAt)
      v.sourceCreatedAt = v.sourceCreatedAt.toISOString();
    else
      delete v.sourceCreatedAt;
    v.canAssign = canAssign(a, v);
    v.canEdit = canDevelop(a, v);
    v.canFollowup = v.canEdit;
    delete v.owner_user_id;
    delete v.created_by;
    delete v.development_restriction;
    return success({ ...v, contacts: contacts2.rows, activities: activities.rows.map((x) => ({ ...x, createdAt: x.createdAt.toISOString(), occurredAt: x.occurredAt.toISOString(), recordedAt: x.recordedAt.toISOString() })) });
  }
  detail(hash, id) {
    return this.authorized(hash, (c, a) => this.detailIn(c, a, id));
  }
  claim(hash, _input) {
    return this.authorized(hash, async () => failure("CONFLICT", "\u8BF7\u901A\u8FC7\u8054\u7CFB\u4EBA\u5206\u914D\u8BF7\u6C42\u63A5\u6536\u7EBF\u7D22"));
  }
  followup(hash, input) {
    return this.authorized(hash, async (c, a) => {
      if (!a.capabilities.includes("leads.develop"))
        return failure("FORBIDDEN", "\u65E0\u8DDF\u8FDB\u6743\u9650");
      const row2 = await c.query("SELECT * FROM crm_customers WHERE customer_id=$1 FOR UPDATE", [input.customerId]);
      if (!row2.rows.length || !canDevelop(a, row2.rows[0]))
        return failure("NOT_FOUND", "\u5BA2\u6237\u4E0D\u5B58\u5728");
      if ((await c.query("SELECT 1 FROM crm_contact_assignment_requests WHERE customer_id=$1 AND status IN ('pending','accepted') LIMIT 1", [input.customerId])).rows.length)
        return failure("CONFLICT", "\u5BA2\u6237\u542B\u72EC\u7ACB\u5206\u914D\u8054\u7CFB\u4EBA\uFF0C\u8BF7\u4F7F\u7528\u8054\u7CFB\u4EBA\u8DDF\u8FDB");
      return this.cached(c, a, `followup:${input.customerId}`, input, async () => {
        if (row2.rows[0].version !== input.expectedVersion)
          return failure("CONFLICT", "\u5BA2\u6237\u7248\u672C\u5DF2\u53D8\u5316");
        const method = input.method ?? "other";
        if (input.opportunityId) {
          const opportunity = await c.query("SELECT opportunity_id FROM crm_opportunities WHERE opportunity_id=$1 AND customer_id=$2", [input.opportunityId, input.customerId]);
          if (!opportunity.rows.length)
            return failure("INVALID_INPUT", "\u5546\u673A\u4E0D\u5C5E\u4E8E\u5F53\u524D\u5BA2\u6237");
        }
        if (input.contactStatus !== void 0 && (input.contactId === void 0 || method === "note"))
          return failure("INVALID_INPUT", "\u89E6\u8FBE\u7ED3\u679C\u9700\u8981\u6307\u5B9A\u8054\u7CFB\u4EBA\u548C\u8054\u7CFB\u6D3B\u52A8");
        if (input.contactId !== void 0) {
          const contact2 = await c.query("SELECT contact_id FROM crm_customer_contacts WHERE customer_id=$1 AND contact_id=$2", [input.customerId, input.contactId]);
          if (!contact2.rows.length)
            return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u4E0D\u5C5E\u4E8E\u5F53\u524D\u5BA2\u6237");
        }
        const clock = await c.query("SELECT clock_timestamp() AS recorded");
        const recordedAt = clock.rows[0].recorded;
        const occurredAt = input.occurredAt === void 0 ? recordedAt : new Date(input.occurredAt);
        const MILLISECONDS_PER_SECOND13 = 1e3;
        if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > recordedAt.getTime() + FOLLOWUP_TIME_LIMITS.future_skew_seconds * MILLISECONDS_PER_SECOND13)
          return failure("INVALID_INPUT", "\u53D1\u751F\u65F6\u95F4\u65E0\u6548\u6216\u8D85\u8FC7\u4E2D\u5FC3\u65F6\u95F4");
        const activity = await c.query("INSERT INTO crm_shared_activities(customer_id,interaction_id,actor_id,note,stage,method,occurred_at,recorded_at,created_at,contact_id,contact_status,opportunity_id) VALUES($1,NULL,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10) RETURNING id::text", [input.customerId, a.userId, input.note, input.stage ?? null, method, occurredAt, recordedAt, input.contactId ?? null, input.contactStatus ?? null, input.opportunityId ?? null]);
        if (input.contactStatus !== void 0)
          await c.query("UPDATE contacts SET crm_touch_status=$2,crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1", [input.contactId, input.contactStatus]);
        await c.query("UPDATE crm_customers SET version=version+1,relationship_stage=COALESCE($2,relationship_stage),stage_needs_review=CASE WHEN $2 IS NOT NULL THEN false ELSE stage_needs_review END WHERE customer_id=$1", [input.customerId, input.stage ?? null]);
        await this.event(c, a, input.customerId, input.expectedVersion + 1, "crm.lead.followup", activity.rows[0].id);
        return this.detailIn(c, a, input.customerId);
      });
    });
  }
};

// server/core/center-contacts.ts
var CENTER_CONTACT_ROUTE = "/api/crm/contacts";
var CENTER_CONTACT_GROUP_ROUTE = "/api/crm/contact-groups";
var CENTER_CONTACT_LIMITS = { page: 50, pageMax: 100, text: 500 };
var CENTER_CONTACT_GROUP_LIMITS = { page: 24, pageMax: 100 };
var CENTER_CONTACT_GROUP_DIMENSIONS = ["batch", "country", "company", "clientType"];
var CENTER_CONTACT_FILTERS = ["stage", "status", "tags", "clientType", "country", "language"];
function centerContactQuery(value2) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
    return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u67E5\u8BE2\u53C2\u6570\u65E0\u6548");
  const input = value2;
  const allowed = ["search", "limit", "offset", ...CENTER_CONTACT_FILTERS, "scope", "assignment", "followupOnly", "crmStage", "touchStatus", "groupDimension", "groupKey"];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u67E5\u8BE2\u542B\u672A\u77E5\u53C2\u6570");
  const search = input.search ?? "";
  const limit = input.limit ?? CENTER_CONTACT_LIMITS.page;
  const offset = input.offset ?? 0;
  if (typeof search !== "string" || search.length > CENTER_CONTACT_LIMITS.text || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > CENTER_CONTACT_LIMITS.pageMax || !Number.isSafeInteger(offset) || Number(offset) < 0)
    return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u5206\u9875\u6216\u641C\u7D22\u53C2\u6570\u65E0\u6548");
  const query = { search: search.trim(), limit: Number(limit), offset: Number(offset) };
  if (input.scope !== void 0) {
    if (!["all", "personal", "assigned"].includes(input.scope))
      return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u6765\u6E90\u65E0\u6548");
    query.scope = input.scope;
  }
  if (input.assignment !== void 0) {
    if (input.assignment !== "accepted")
      return failure("INVALID_INPUT", "\u5206\u914D\u72B6\u6001\u65E0\u6548");
    query.assignment = "accepted";
  }
  if (input.followupOnly !== void 0) {
    if (typeof input.followupOnly !== "boolean")
      return failure("INVALID_INPUT", "\u8DDF\u8FDB\u7B5B\u9009\u65E0\u6548");
    query.followupOnly = input.followupOnly;
  }
  if (input.crmStage !== void 0) {
    if (!["cold", ...CRM_STAGES].includes(input.crmStage))
      return failure("INVALID_INPUT", "\u5BA2\u6237\u5173\u7CFB\u9636\u6BB5\u65E0\u6548");
    query.crmStage = input.crmStage;
  }
  if (input.touchStatus !== void 0) {
    if (!CONTACT_TOUCH_STATUSES.includes(input.touchStatus))
      return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u8054\u7CFB\u72B6\u6001\u65E0\u6548");
    query.touchStatus = input.touchStatus;
  }
  for (const key of CENTER_CONTACT_FILTERS) {
    const item = input[key];
    if (item === void 0)
      continue;
    if (typeof item !== "string" || item.length > CENTER_CONTACT_LIMITS.text)
      return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u7B5B\u9009\u53C2\u6570\u65E0\u6548");
    if (item.trim())
      query[key] = item.trim();
  }
  if (input.groupDimension !== void 0 || input.groupKey !== void 0) {
    if (!CENTER_CONTACT_GROUP_DIMENSIONS.includes(input.groupDimension) || typeof input.groupKey !== "string" || !input.groupKey.trim() || input.groupKey.length > CENTER_CONTACT_LIMITS.text)
      return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u5206\u7EC4\u7B5B\u9009\u65E0\u6548");
    query.groupDimension = input.groupDimension;
    query.groupKey = input.groupKey.trim();
  }
  return success(query);
}
function centerContactGroupQuery(value2) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
    return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u5206\u7EC4\u67E5\u8BE2\u65E0\u6548");
  const input = value2;
  if (Object.keys(input).some((key) => !["dimension", "scope", "search", "limit", "offset"].includes(key)))
    return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u5206\u7EC4\u67E5\u8BE2\u542B\u672A\u77E5\u53C2\u6570");
  const dimension = input.dimension ?? "batch";
  const scope = input.scope ?? "all";
  const search = input.search ?? "";
  const limit = input.limit ?? CENTER_CONTACT_GROUP_LIMITS.page;
  const offset = input.offset ?? 0;
  if (!CENTER_CONTACT_GROUP_DIMENSIONS.includes(dimension) || !["all", "personal", "assigned"].includes(scope) || typeof search !== "string" || search.length > CENTER_CONTACT_LIMITS.text || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > CENTER_CONTACT_GROUP_LIMITS.pageMax || !Number.isSafeInteger(offset) || Number(offset) < 0)
    return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u5206\u7EC4\u67E5\u8BE2\u53C2\u6570\u65E0\u6548");
  return success({ dimension, scope, search: search.trim(), limit: Number(limit), offset: Number(offset) });
}

// server/services/leads.ts
var UUID5 = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function record4(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function text3(v, max, min = 1) {
  return typeof v === "string" && v.trim().length >= min && v.length <= max;
}
function keys2(v, allowed) {
  return Object.keys(v).every((k) => allowed.includes(k));
}
function command(v) {
  return record4(v) && text3(v.customerId, LEAD_LIMITS.key) && UUID5.test(v.customerId) && Number.isSafeInteger(v.expectedVersion) && Number(v.expectedVersion) > 0 && text3(v.idempotencyKey, LEAD_LIMITS.key);
}
var CONTACT_EMAIL_MAX = 254;
function contacts(v, update = false) {
  return Array.isArray(v) && v.length <= LEAD_LIMITS.batchRows && v.every((x) => record4(x) && keys2(x, ["email", "name", "country", "phone", "whatsapp", "title", ...update ? ["contactId"] : []]) && text3(x.email, CONTACT_EMAIL_MAX, 0) && (x.email.trim() ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.email.trim()) : [x.name, x.phone, x.whatsapp].some((v2) => typeof v2 === "string" && v2.trim())) && ["name", "country", "phone", "whatsapp", "title"].every((k) => x[k] === void 0 || text3(x[k], LEAD_LIMITS.text, 0)) && (x.contactId === void 0 || update && Number.isSafeInteger(x.contactId) && Number(x.contactId) > 0)) && new Set(v.filter((x) => x.email.trim()).map((x) => x.email.trim().toLowerCase())).size === v.filter((x) => x.email.trim()).length;
}
var PROFILE_KEYS = ["customerType", "businessType", "developmentRestriction", "sourceCreatedAt"];
var MILLISECONDS_PER_SECOND9 = 1e3;
var ISO_TIME_PART_LIMITS = { hours: 24, minutes: 60, seconds: 60 };
function validOccurrence(value2) {
  if (typeof value2 !== "string")
    return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value2);
  if (!parts)
    return false;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = parts;
  const date = /* @__PURE__ */ new Date(`${year}-${month}-${day}T00:00:00Z`);
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() + 1 === Number(month) && date.getUTCDate() === Number(day) && Number(hour) < ISO_TIME_PART_LIMITS.hours && Number(minute) < ISO_TIME_PART_LIMITS.minutes && Number(second) < ISO_TIME_PART_LIMITS.seconds && (offsetHour === void 0 || Number(offsetHour) < ISO_TIME_PART_LIMITS.hours && Number(offsetMinute) < ISO_TIME_PART_LIMITS.minutes) && Number.isFinite(Date.parse(value2)) && Date.parse(value2) <= Date.now() + FOLLOWUP_TIME_LIMITS.future_skew_seconds * MILLISECONDS_PER_SECOND9;
}
function profile(v) {
  return (v.customerType === void 0 || v.customerType === "" || v.customerType === "\u4EE3\u7406" || v.customerType === "\u76F4\u5BA2") && ["businessType", "developmentRestriction"].every((k) => v[k] === void 0 || text3(v[k], LEAD_LIMITS.text, 0)) && (v.sourceCreatedAt === void 0 || typeof v.sourceCreatedAt === "string" && (v.sourceCreatedAt === "" || normalizeSourceDate(v.sourceCreatedAt) !== void 0));
}
function createLeadService(repo, tokens) {
  function run2(token, action) {
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? action(tokens.hash(token)) : Promise.resolve(failure("UNAUTHORIZED", "\u4F1A\u8BDD\u65E0\u6548"));
  }
  return {
    contacts(token, input) {
      const query = centerContactQuery(input);
      if (!query.ok)
        return Promise.resolve(query);
      return run2(token, (h) => repo.listContacts ? repo.listContacts(h, query.data) : Promise.resolve(failure("UNAVAILABLE", "\u8054\u7CFB\u4EBA\u67E5\u8BE2\u6682\u4E0D\u53EF\u7528")));
    },
    contactGroups(token, input) {
      const query = centerContactGroupQuery(input);
      if (!query.ok)
        return Promise.resolve(query);
      return run2(token, (h) => repo.listContactGroups ? repo.listContactGroups(h, query.data) : Promise.resolve(failure("UNAVAILABLE", "\u8054\u7CFB\u4EBA\u5206\u7EC4\u6682\u4E0D\u53EF\u7528")));
    },
    createCustomer(token, v) {
      if (!record4(v) || !keys2(v, ["companyName", "country", "source", "sourceDetail", "contacts", "idempotencyKey", ...PROFILE_KEYS]) || !profile(v) || !text3(v.companyName, LEAD_LIMITS.text) || v.country !== void 0 && !text3(v.country, LEAD_LIMITS.text, 0) || !text3(v.source, LEAD_LIMITS.text) || !text3(v.sourceDetail, LEAD_LIMITS.text, 0) || !text3(v.idempotencyKey, LEAD_LIMITS.key) || !contacts(v.contacts))
        return Promise.resolve(failure("INVALID_INPUT", "\u5BA2\u6237\u53C2\u6570\u65E0\u6548"));
      return run2(token, (h) => repo.createCustomer ? repo.createCustomer(h, v) : Promise.resolve(failure("UNAVAILABLE", "\u5BA2\u6237\u521B\u5EFA\u6682\u4E0D\u53EF\u7528")));
    },
    updateCustomer(token, v) {
      if (!command(v) || !record4(v) || !keys2(v, ["customerId", "companyName", "country", "contacts", "expectedVersion", "idempotencyKey", ...PROFILE_KEYS]) || !profile(v) || !text3(v.companyName, LEAD_LIMITS.text) || v.country !== void 0 && !text3(v.country, LEAD_LIMITS.text, 0) || !contacts(v.contacts, true))
        return Promise.resolve(failure("INVALID_INPUT", "\u5BA2\u6237\u66F4\u65B0\u53C2\u6570\u65E0\u6548"));
      return run2(token, (h) => repo.updateCustomer ? repo.updateCustomer(h, v) : Promise.resolve(failure("UNAVAILABLE", "\u5BA2\u6237\u66F4\u65B0\u6682\u4E0D\u53EF\u7528")));
    },
    assign(token, v) {
      if (!command(v) || !record4(v) || !keys2(v, ["customerId", "expectedVersion", "idempotencyKey", "salesUserId", "notifyUserIds"]) || typeof v.salesUserId !== "string" || !UUID5.test(v.salesUserId) || !Array.isArray(v.notifyUserIds) || v.notifyUserIds.length > LEAD_LIMITS.notifyMax || v.notifyUserIds.some((x) => typeof x !== "string" || !UUID5.test(x)) || new Set(v.notifyUserIds).size !== v.notifyUserIds.length)
        return Promise.resolve(failure("INVALID_INPUT", "\u5206\u914D\u53C2\u6570\u65E0\u6548"));
      return run2(token, (h) => repo.assign ? repo.assign(h, v) : Promise.resolve(failure("UNAVAILABLE", "\u5206\u914D\u6682\u4E0D\u53EF\u7528")));
    },
    members(token, v) {
      if (!v || !text3(v.search, LEAD_LIMITS.text, 0) || !Number.isSafeInteger(v.limit) || v.limit < 1 || v.limit > LEAD_LIMITS.pageMax || !Number.isSafeInteger(v.offset) || v.offset < 0)
        return Promise.resolve(failure("INVALID_INPUT", "\u6210\u5458\u53C2\u6570\u65E0\u6548"));
      return run2(token, (h) => repo.members ? repo.members(h, v) : Promise.resolve(failure("UNAVAILABLE", "\u6210\u5458\u76EE\u5F55\u6682\u4E0D\u53EF\u7528")));
    },
    bootstrap: (token) => run2(token, (h) => repo.bootstrap(h)),
    importWorkbook(token, v) {
      if (!record4(v) || !keys2(v, ["source", "sourceDetail", "idempotencyKey", "kind", "rows"]) || !text3(v.source, LEAD_LIMITS.text) || !text3(v.sourceDetail, LEAD_LIMITS.text, 0) || !text3(v.idempotencyKey, LEAD_LIMITS.key) || !["personal", "operations"].includes(v.kind) || !Array.isArray(v.rows) || !v.rows.length || v.rows.length > WORKBOOK_LIMITS.batchRows)
        return Promise.resolve(failure("INVALID_INPUT", "\u5DE5\u4F5C\u7C3F\u5BFC\u5165\u53C2\u6570\u65E0\u6548\u6216\u8D85\u8FC7200\u884C"));
      const allowed = ["entity", "sourceRef", "customerRef", "companyName", "country", "customerType", "businessType", "developmentRestriction", "sourceCreatedAt", "email", "name", "firstName", "lastName", "phone", "whatsapp", "title", "linkedinUrl", "language", "clientType", "sourceLevel1", "sourceLevel2", "stage", "status", "tags", "sheetName", "rowNumber", "rawRow"];
      if (v.rows.some((r) => !record4(r) || !keys2(r, allowed) || !["customer", "contact"].includes(r.entity) || typeof r.sourceRef !== "string" || typeof r.sheetName !== "string" || !Number.isSafeInteger(r.rowNumber) || Number(r.rowNumber) < 1 || !record4(r.rawRow) || ["customerRef", "companyName", "country", "customerType", "businessType", "developmentRestriction", "sourceCreatedAt", "email", "name", "firstName", "lastName", "phone", "whatsapp", "title", "linkedinUrl", "language", "clientType", "sourceLevel1", "sourceLevel2", "stage", "status"].some((k) => r[k] !== void 0 && typeof r[k] !== "string") || r.tags !== void 0 && (!Array.isArray(r.tags) || r.tags.some((t) => typeof t !== "string"))))
        return Promise.resolve(failure("INVALID_INPUT", "\u5DE5\u4F5C\u7C3F\u6765\u6E90\u884C\u683C\u5F0F\u65E0\u6548"));
      return run2(token, (h) => repo.importWorkbook ? repo.importWorkbook(h, v) : Promise.resolve(failure("UNAVAILABLE", "\u5DE5\u4F5C\u7C3F\u5BFC\u5165\u6682\u4E0D\u53EF\u7528")));
    },
    importRows(token, v) {
      if (!record4(v) || !keys2(v, ["source", "sourceDetail", "idempotencyKey", "rows", "mapping", "kind", "companyMatching"]) || v.kind !== void 0 && !["personal", "operations"].includes(v.kind) || !text3(v.source, LEAD_LIMITS.text) || !text3(v.sourceDetail, LEAD_LIMITS.text, 0) || !text3(v.idempotencyKey, LEAD_LIMITS.key) || !Array.isArray(v.rows) || !v.rows.length || v.rows.length > LEAD_LIMITS.batchRows || v.mapping !== void 0 && (!record4(v.mapping) || Object.values(v.mapping).some((x) => !text3(x, LEAD_LIMITS.text))))
        return Promise.resolve(failure("INVALID_INPUT", "\u5BFC\u5165\u53C2\u6570\u65E0\u6548\u6216\u8D85\u8FC7200\u884C"));
      if (v.companyMatching !== void 0 && typeof v.companyMatching !== "boolean")
        return Promise.resolve(failure("INVALID_INPUT", "\u516C\u53F8\u5339\u914D\u53C2\u6570\u65E0\u6548"));
      if (v.rows.some((r) => !record4(r) || !keys2(r, ["customerKey", "companyName", "email", "name", "country", "customerType", "businessType", "website", "whatsapp", "sourceLevel1", "sourceLevel2", "firstName", "lastName", "title", "phone", "linkedinUrl", "language", "clientType", "stage", "status", "tags", "rawRow"]) || typeof r.customerKey !== "string" || typeof r.companyName !== "string" || typeof r.email !== "string" || ["name", "country", "customerType", "businessType", "website", "whatsapp", "sourceLevel1", "sourceLevel2", "firstName", "lastName", "title", "phone", "linkedinUrl", "language", "clientType", "stage", "status"].some((k) => r[k] !== void 0 && typeof r[k] !== "string") || r.tags !== void 0 && (!Array.isArray(r.tags) || r.tags.some((t) => typeof t !== "string")) || r.rawRow !== void 0 && !record4(r.rawRow)))
        return Promise.resolve(failure("INVALID_INPUT", "\u5BFC\u5165\u884C\u65E0\u6548"));
      return run2(token, (h) => repo.importRows(h, v));
    },
    publish(token, id, v) {
      if (!UUID5.test(id) || !record4(v) || !keys2(v, ["rowIds", "expectedVersion", "idempotencyKey"]) || !Array.isArray(v.rowIds) || !v.rowIds.length || v.rowIds.length > LEAD_LIMITS.batchRows || v.rowIds.some((x) => typeof x !== "string" || !UUID5.test(x)) || !Number.isSafeInteger(v.expectedVersion) || Number(v.expectedVersion) < 1 || !text3(v.idempotencyKey, LEAD_LIMITS.key))
        return Promise.resolve(failure("INVALID_INPUT", "\u53D1\u5E03\u53C2\u6570\u65E0\u6548"));
      return run2(token, (h) => repo.publish(h, id, v));
    },
    list(token, v) {
      if (!v || !["pool", "mine", "operations", "personal", "assigned", "all"].includes(v.view) || !text3(v.search, LEAD_LIMITS.text, 0) || !Number.isSafeInteger(v.limit) || v.limit < 1 || v.limit > LEAD_LIMITS.pageMax || !Number.isSafeInteger(v.offset) || v.offset < 0 || v.assignment !== void 0 && !["unassigned", "assigned"].includes(v.assignment) || v.followupOnly !== void 0 && (typeof v.followupOnly !== "boolean" || v.followupOnly && v.view === "pool") || v.stage !== void 0 && (!["cold", ...CRM_STAGES].includes(v.stage) || v.view === "pool"))
        return Promise.resolve(failure("INVALID_INPUT", "\u5217\u8868\u53C2\u6570\u65E0\u6548"));
      return run2(token, (h) => repo.list(h, v));
    },
    detail(token, id) {
      return UUID5.test(id) ? run2(token, (h) => repo.detail(h, id)) : Promise.resolve(failure("NOT_FOUND", "\u5BA2\u6237\u4E0D\u5B58\u5728"));
    },
    claim(token, v) {
      if (!command(v) || !keys2(v, ["customerId", "expectedVersion", "idempotencyKey"]))
        return Promise.resolve(failure("INVALID_INPUT", "\u9886\u53D6\u53C2\u6570\u65E0\u6548"));
      return run2(token, (h) => repo.claim(h, v));
    },
    followup(token, v) {
      if (!command(v) || !record4(v) || !keys2(v, ["customerId", "expectedVersion", "idempotencyKey", "note", "stage", "method", "occurredAt", "contactId", "contactStatus", "opportunityId"]) || v.opportunityId !== void 0 && (typeof v.opportunityId !== "string" || !UUID5.test(v.opportunityId)) || !text3(v.note, LEAD_LIMITS.note) || v.stage !== void 0 && !["cold", ...CRM_STAGES].includes(v.stage) || v.method !== void 0 && !FOLLOWUP_METHODS.includes(v.method) || v.occurredAt !== void 0 && !validOccurrence(v.occurredAt) || v.contactId !== void 0 && (!Number.isSafeInteger(v.contactId) || Number(v.contactId) < 1) || v.contactStatus !== void 0 && (!CONTACT_TOUCH_STATUSES.includes(v.contactStatus) || v.contactId === void 0 || v.method === "note"))
        return Promise.resolve(failure("INVALID_INPUT", "\u8DDF\u8FDB\u53C2\u6570\u65E0\u6548"));
      return run2(token, (h) => repo.followup(h, v));
    }
  };
}

// server/core/crm-lifecycle.ts
var COMPANY_ROUTE = "/api/crm/companies";
var CONTACT_DELETE_ROUTE = "/api/crm/contacts/delete";
var LIFECYCLE_LIMITS = { batch: 200, text: 500, key: 128, page: 50, pageMax: 100 };

// server/services/crm-lifecycle.ts
var record5 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var keys3 = (v, allowed) => Object.keys(v).every((k) => allowed.includes(k));
var text4 = (v, max, min = 1) => typeof v === "string" && v.trim().length >= min && v.length <= max;
var positive2 = (v) => Number.isSafeInteger(v) && Number(v) > 0;
var uuid2 = (v) => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
var invalid3 = () => failure("INVALID_INPUT", "\u8D44\u6599\u64CD\u4F5C\u53C2\u6570\u65E0\u6548");
function contactDelete(v) {
  if (!record5(v) || !keys3(v, ["contacts", "idempotencyKey"]) || !text4(v.idempotencyKey, LIFECYCLE_LIMITS.key) || !Array.isArray(v.contacts) || !v.contacts.length || v.contacts.length > LIFECYCLE_LIMITS.batch || v.contacts.some((r) => !record5(r) || !keys3(r, ["contactId", "customerId", "expectedVersion"]) || !positive2(r.contactId) || !uuid2(r.customerId) || !positive2(r.expectedVersion)) || new Set(v.contacts.map((r) => r.contactId)).size !== v.contacts.length)
    return invalid3();
  return success(v);
}
function companyCreate(v) {
  if (!record5(v) || !keys3(v, ["name", "domain", "idempotencyKey"]) || !text4(v.name, LIFECYCLE_LIMITS.text) || !text4(v.idempotencyKey, LIFECYCLE_LIMITS.key) || v.domain !== void 0 && v.domain !== null && (!text4(v.domain, LIFECYCLE_LIMITS.text) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(v.domain.trim())))
    return invalid3();
  return success({ name: v.name.trim(), domain: typeof v.domain === "string" ? v.domain.trim().toLowerCase() : null, idempotencyKey: v.idempotencyKey });
}
function companyDelete(v) {
  return record5(v) && keys3(v, ["companyId", "expectedRevision", "idempotencyKey"]) && positive2(v.companyId) && text4(v.expectedRevision, LIFECYCLE_LIMITS.text) && text4(v.idempotencyKey, LIFECYCLE_LIMITS.key) ? success(v) : invalid3();
}
function companyQuery(v) {
  if (!record5(v) || !keys3(v, ["search", "scope", "limit", "offset"]))
    return invalid3();
  const q = { search: v.search ?? "", scope: v.scope ?? "all", limit: v.limit ?? LIFECYCLE_LIMITS.page, offset: v.offset ?? 0 };
  return text4(q.search, LIFECYCLE_LIMITS.text, 0) && ["all", "personal", "assigned"].includes(String(q.scope)) && positive2(q.limit) && Number(q.limit) <= LIFECYCLE_LIMITS.pageMax && Number.isSafeInteger(q.offset) && Number(q.offset) >= 0 ? success(q) : invalid3();
}
function companyRef(v) {
  return record5(v) && keys3(v, ["companyId", "scope"]) && positive2(v.companyId) && ["all", "personal", "assigned"].includes(String(v.scope ?? "all")) ? success({ companyId: Number(v.companyId), scope: v.scope ?? "all" }) : invalid3();
}
function createLifecycleService(repo, tokens) {
  function run2(token, v, parse, send2) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      return Promise.resolve(failure("UNAUTHORIZED", "\u4F1A\u8BDD\u65E0\u6548"));
    const p = parse(v);
    return p.ok ? send2(tokens.hash(token), p.data) ?? Promise.resolve(failure("UNAVAILABLE", "\u8D44\u6599\u64CD\u4F5C\u5C1A\u672A\u5F00\u653E")) : Promise.resolve(p);
  }
  return { deleteContacts: (t, v) => run2(t, v, contactDelete, (h, i) => repo.deleteContacts?.(h, i)), createCompany: (t, v) => run2(t, v, companyCreate, (h, i) => repo.createCompany?.(h, i)), deleteCompany: (t, v) => run2(t, v, companyDelete, (h, i) => repo.deleteCompany?.(h, i)), companies: (t, v) => run2(t, v, companyQuery, (h, i) => repo.companies?.(h, i)), companyDetail: (t, v) => run2(t, v, companyRef, (h, i) => repo.companyDetail?.(h, i)) };
}

// server/services/contact-assignments.ts
var UUID6 = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
var MILLISECONDS_PER_SECOND10 = 1e3;
var EMAIL_LIMIT2 = 254;
var TIME_LIMIT = { hour: 24, minute: 60, second: 60 };
var UPDATE_FIELDS = ["email", "firstName", "lastName", "title", "phone", "whatsapp", "sourceLevel1", "sourceLevel2", "linkedinUrl", "country", "clientType", "language", "stage", "status", "tags", "preferences"];
function record6(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function keys4(v, allowed) {
  return Object.keys(v).every((k) => allowed.includes(k));
}
function text5(v, max, min = 1) {
  return typeof v === "string" && v.trim().length >= min && v.length <= max;
}
function uuid3(v) {
  return typeof v === "string" && UUID6.test(v);
}
function positive3(v) {
  return Number.isSafeInteger(v) && Number(v) > 0;
}
function version2(v) {
  return positive3(v.expectedVersion) && text5(v.idempotencyKey, CONTACT_ASSIGNMENT_LIMITS.key);
}
function ref(v) {
  return positive3(v.contactId) && uuid3(v.customerId);
}
function invalid4() {
  return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u6216\u5206\u914D\u53C2\u6570\u65E0\u6548");
}
function contactRef(v) {
  return record6(v) && keys4(v, ["contactId", "customerId"]) && ref(v) ? success(v) : invalid4();
}
var COMPANY_FIELDS = ["customerType", "name", "domain", "country", "industry", "size", "backcheckData"];
var COMPANY_REPORT_MAX = 1e5;
function companyUpdate(v) {
  if (!record6(v) || !keys4(v, ["contactId", "customerId", "expectedRevision", "idempotencyKey", "fields"]) || !ref(v) || !text5(v.idempotencyKey, CONTACT_ASSIGNMENT_LIMITS.key) || !text5(v.expectedRevision, CONTACT_ASSIGNMENT_LIMITS.text) || !record6(v.fields) || !Object.keys(v.fields).length || !keys4(v.fields, COMPANY_FIELDS))
    return invalid4();
  for (const [field, value2] of Object.entries(v.fields)) {
    if (field === "customerType" && value2 !== null && value2 !== "\u4EE3\u7406" && value2 !== "\u76F4\u5BA2")
      return invalid4();
    if (field === "backcheckData") {
      if (value2 !== null && (!record6(value2) || JSON.stringify(value2).length > COMPANY_REPORT_MAX))
        return invalid4();
    } else if (field === "name" ? !text5(value2, CONTACT_ASSIGNMENT_LIMITS.text) : value2 !== null && !text5(value2, CONTACT_ASSIGNMENT_LIMITS.text, 0))
      return invalid4();
  }
  return success(v);
}
function contactAssignmentCreate(v) {
  if (!record6(v) || !keys4(v, ["contacts", "targetUserId", "notifyUserIds", "idempotencyKey"]) || !uuid3(v.targetUserId) || !text5(v.idempotencyKey, CONTACT_ASSIGNMENT_LIMITS.key) || !Array.isArray(v.contacts) || !v.contacts.length || v.contacts.length > CONTACT_ASSIGNMENT_LIMITS.batch || v.contacts.some((x) => !record6(x) || !keys4(x, ["contactId", "customerId", "expectedVersion"]) || !ref(x) || !positive3(x.expectedVersion)) || new Set(v.contacts.map((x) => x.contactId)).size !== v.contacts.length || !Array.isArray(v.notifyUserIds) || v.notifyUserIds.length > CONTACT_ASSIGNMENT_LIMITS.notify || v.notifyUserIds.some((x) => !uuid3(x)) || new Set(v.notifyUserIds).size !== v.notifyUserIds.length)
    return invalid4();
  return success(v);
}
function contactAssignmentDecision(v) {
  return record6(v) && keys4(v, ["requestId", "expectedVersion", "idempotencyKey"]) && uuid3(v.requestId) && version2(v) ? success(v) : invalid4();
}
function contactAssignmentGroupDecision(v) {
  return record6(v) && keys4(v, ["groupId", "idempotencyKey"]) && uuid3(v.groupId) && text5(v.idempotencyKey, CONTACT_ASSIGNMENT_LIMITS.key) ? success(v) : invalid4();
}
function contactAssignmentQuery(v) {
  if (!record6(v) || !keys4(v, ["view", "status", "search", "limit", "offset", "requestId", "groupId"]) || v.requestId !== void 0 && !uuid3(v.requestId) || v.groupId !== void 0 && !uuid3(v.groupId) || v.requestId !== void 0 && v.groupId !== void 0)
    return invalid4();
  const query = { view: v.view ?? "incoming", status: v.status ?? "pending", search: v.search ?? "", limit: v.limit ?? CONTACT_ASSIGNMENT_LIMITS.page, offset: v.offset ?? 0, ...v.requestId !== void 0 ? { requestId: v.requestId } : {}, ...v.groupId !== void 0 ? { groupId: v.groupId } : {} };
  if (!["incoming", "outgoing"].includes(query.view) || !["pending", "accepted", "rejected", "cancelled"].includes(query.status) || !text5(query.search, CONTACT_ASSIGNMENT_LIMITS.text, 0) || !positive3(query.limit) || Number(query.limit) > CONTACT_ASSIGNMENT_LIMITS.pageMax || !Number.isSafeInteger(query.offset) || Number(query.offset) < 0)
    return invalid4();
  return success({ ...query, search: query.search.trim() });
}
function contactAssignmentGroupQuery(v) {
  if (!record6(v) || !keys4(v, ["view", "status", "search", "limit", "offset"]))
    return invalid4();
  const query = { view: v.view ?? "incoming", status: v.status ?? "pending", search: v.search ?? "", limit: v.limit ?? CONTACT_ASSIGNMENT_LIMITS.page, offset: v.offset ?? 0 };
  if (!["incoming", "outgoing"].includes(query.view) || !["pending", "accepted", "rejected", "cancelled"].includes(query.status) || !text5(query.search, CONTACT_ASSIGNMENT_LIMITS.text, 0) || !positive3(query.limit) || Number(query.limit) > CONTACT_ASSIGNMENT_LIMITS.pageMax || !Number.isSafeInteger(query.offset) || Number(query.offset) < 0)
    return invalid4();
  return success({ ...query, search: query.search.trim() });
}
function contactUpdate(v) {
  if (!record6(v) || !keys4(v, ["contactId", "customerId", "expectedVersion", "idempotencyKey", "fields"]) || !ref(v) || !version2(v) || !record6(v.fields) || !Object.keys(v.fields).length || !keys4(v.fields, UPDATE_FIELDS))
    return invalid4();
  for (const [key, value2] of Object.entries(v.fields)) {
    if (key === "tags") {
      if (!Array.isArray(value2) || value2.length > CONTACT_ASSIGNMENT_LIMITS.pageMax || value2.some((x) => !text5(x, CONTACT_ASSIGNMENT_LIMITS.text)) || new Set(value2).size !== value2.length)
        return invalid4();
      continue;
    }
    if (key === "preferences") {
      if (!Array.isArray(value2) || value2.length > CONTACT_ASSIGNMENT_LIMITS.preferences || value2.some((x) => !text5(x, CONTACT_ASSIGNMENT_LIMITS.preferenceText)) || new Set(value2).size !== value2.length)
        return invalid4();
      continue;
    }
    if (value2 !== null && !text5(value2, CONTACT_ASSIGNMENT_LIMITS.text, 0) || ["stage", "status"].includes(key) && value2 === null)
      return invalid4();
    if (key === "email" && typeof value2 === "string" && value2.trim() && (value2.length > EMAIL_LIMIT2 || !/^\S+@[^\s@]+\.[^\s@]+$/.test(value2.trim())))
      return invalid4();
  }
  return success(v);
}
function occurrence2(v) {
  if (typeof v !== "string")
    return false;
  const p = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(v);
  if (!p)
    return false;
  const d = /* @__PURE__ */ new Date(`${p[1]}-${p[2]}-${p[3]}T00:00:00Z`);
  return d.getUTCFullYear() === Number(p[1]) && d.getUTCMonth() + 1 === Number(p[2]) && d.getUTCDate() === Number(p[3]) && Number(p[4]) < TIME_LIMIT.hour && Number(p[5]) < TIME_LIMIT.minute && Number(p[6]) < TIME_LIMIT.second && (p[8] === void 0 || Number(p[8]) < TIME_LIMIT.hour && Number(p[9]) < TIME_LIMIT.minute) && Number.isFinite(Date.parse(v)) && Date.parse(v) <= Date.now() + FOLLOWUP_TIME_LIMITS.future_skew_seconds * MILLISECONDS_PER_SECOND10;
}
function contactFollowup(v) {
  if (!record6(v) || !keys4(v, ["contactId", "customerId", "expectedVersion", "idempotencyKey", "note", "stage", "method", "occurredAt", "contactStatus"]) || !ref(v) || !version2(v) || !text5(v.note, CONTACT_ASSIGNMENT_LIMITS.note) || v.stage !== void 0 && !["cold", ...CRM_STAGES].includes(v.stage) || v.method !== void 0 && !FOLLOWUP_METHODS.includes(v.method) || v.occurredAt !== void 0 && !occurrence2(v.occurredAt) || v.contactStatus !== void 0 && (!CONTACT_TOUCH_STATUSES.includes(v.contactStatus) || v.method === "note"))
    return invalid4();
  return success(v);
}
function createContactAssignmentService(repo, tokens) {
  function run2(token, v, validate, work) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      return Promise.resolve(failure("UNAUTHORIZED", "\u4F1A\u8BDD\u65E0\u6548"));
    const parsed = validate(v);
    return parsed.ok ? work(tokens.hash(token), parsed.data) : Promise.resolve(parsed);
  }
  return { ...createLifecycleService(repo, tokens), companyUpdate: (t, v) => run2(t, v, companyUpdate, (h, i) => repo.companyUpdate?.(h, i) ?? Promise.resolve(failure("UNAVAILABLE", "\u516C\u53F8\u8D44\u6599\u4FDD\u5B58\u5C1A\u672A\u5F00\u653E"))), contactDetail: (t, v) => run2(t, v, contactRef, (h, i) => repo.contactDetail(h, i)), contactUpdate: (t, v) => run2(t, v, contactUpdate, (h, i) => repo.contactUpdate(h, i)), contactFollowup: (t, v) => run2(t, v, contactFollowup, (h, i) => repo.contactFollowup(h, i)), assignmentGroups: (t, v) => run2(t, v, contactAssignmentGroupQuery, (h, i) => repo.contactAssignmentGroups(h, i)), assignments: (t, v) => run2(t, v, contactAssignmentQuery, (h, i) => repo.contactAssignments(h, i)), createAssignments: (t, v) => run2(t, v, contactAssignmentCreate, (h, i) => repo.createContactAssignments(h, i)), decide: (t, action, v) => run2(t, v, contactAssignmentDecision, (h, i) => repo.decideContactAssignment(h, action, i)), decideGroup: (t, action, v) => run2(t, v, contactAssignmentGroupDecision, (h, i) => repo.decideContactAssignmentGroup(h, action, i)) };
}

// server/transport/crm-lifecycle-http.ts
function createLifecycleHandler(service) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost"), path4 = url.pathname, token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const company = /^\/api\/crm\/companies\/(\d+)(?:\/(delete))?$/.exec(path4);
    if (req.method === "GET") {
      const q = {};
      for (const [k, v] of url.searchParams) {
        if (k in q) {
          send(res, failure("INVALID_INPUT", "\u67E5\u8BE2\u53C2\u6570\u91CD\u590D"));
          return;
        }
        q[k] = ["limit", "offset"].includes(k) ? Number(v) : v;
      }
      if (path4 === COMPANY_ROUTE) {
        send(res, await service.companies(token, q));
        return;
      }
      if (company && !company[2]) {
        if (Object.keys(q).some((k) => k !== "scope")) {
          send(res, failure("INVALID_INPUT", "\u516C\u53F8\u53C2\u6570\u65E0\u6548"));
          return;
        }
        send(res, await service.companyDetail(token, { companyId: Number(company[1]), ...q }));
        return;
      }
    }
    if (req.method === "POST") {
      const p = await body(req, LEAD_LIMITS.bodyBytes);
      if (!p.ok) {
        send(res, p);
        return;
      }
      if (path4 === CONTACT_DELETE_ROUTE) {
        send(res, await service.deleteContacts(token, p.data));
        return;
      }
      if (path4 === COMPANY_ROUTE) {
        send(res, await service.createCompany(token, p.data));
        return;
      }
      if (company?.[2] === "delete") {
        if (!p.data || typeof p.data !== "object" || Array.isArray(p.data) || "companyId" in p.data && p.data.companyId !== Number(company[1])) {
          send(res, failure("INVALID_INPUT", "\u8DEF\u5F84\u4E0E\u516C\u53F8\u7F16\u53F7\u4E0D\u4E00\u81F4"));
          return;
        }
        send(res, await service.deleteCompany(token, { ...p.data, companyId: Number(company[1]) }));
        return;
      }
    }
    send(res, failure("NOT_FOUND", "\u8D44\u6599\u64CD\u4F5C\u63A5\u53E3\u4E0D\u5B58\u5728"));
  };
}

// server/transport/contact-assignments-http.ts
function createContactAssignmentHandler(service) {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`), path4 = url.pathname, token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (path4 === CONTACT_DELETE_ROUTE || path4 === COMPANY_ROUTE || path4.startsWith(COMPANY_ROUTE + "/")) {
      await createLifecycleHandler(service)(req, res);
      return;
    }
    if (req.method === "GET" && path4 === CONTACT_ASSIGNMENT_ROUTES.assignments) {
      const query = {};
      for (const [k, v] of url.searchParams) {
        if (k in query) {
          send(res, failure("INVALID_INPUT", "\u67E5\u8BE2\u53C2\u6570\u91CD\u590D"));
          return;
        }
        query[k] = ["limit", "offset"].includes(k) ? Number(v) : v;
      }
      send(res, await service.assignments(token, query));
      return;
    }
    if (req.method === "GET" && path4 === CONTACT_ASSIGNMENT_ROUTES.groups) {
      const query = {};
      for (const [k, v] of url.searchParams) {
        if (k in query) {
          send(res, failure("INVALID_INPUT", "\u67E5\u8BE2\u53C2\u6570\u91CD\u590D"));
          return;
        }
        query[k] = ["limit", "offset"].includes(k) ? Number(v) : v;
      }
      send(res, await service.assignmentGroups(token, query));
      return;
    }
    const contact2 = /^\/api\/crm\/contacts\/(\d+)(?:\/(update|followups|company))?$/.exec(path4);
    if (req.method === "GET" && contact2 && !contact2[2]) {
      if ([...url.searchParams.keys()].some((k) => k !== "customerId") || url.searchParams.getAll("customerId").length !== 1) {
        send(res, failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u53C2\u6570\u65E0\u6548"));
        return;
      }
      send(res, await service.contactDetail(token, { contactId: Number(contact2[1]), customerId: url.searchParams.get("customerId") }));
      return;
    }
    if (req.method === "POST") {
      const parsed = await body(req, LEAD_LIMITS.bodyBytes);
      if (!parsed.ok) {
        send(res, parsed);
        return;
      }
      if (path4 === CONTACT_ASSIGNMENT_ROUTES.assignments) {
        send(res, await service.createAssignments(token, parsed.data));
        return;
      }
      const decision = /^\/api\/crm\/contact-assignments\/([^/]+)\/(accept|reject|cancel)$/.exec(path4), groupDecision = /^\/api\/crm\/contact-assignments\/groups\/([^/]+)\/(accept|reject|cancel)$/.exec(path4), field = decision ? "requestId" : groupDecision ? "groupId" : "contactId", id = decision || groupDecision ? (decision ?? groupDecision)[1] : contact2 ? Number(contact2[1]) : void 0;
      if (decision || groupDecision || contact2?.[2]) {
        if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data) || field in parsed.data && parsed.data[field] !== id) {
          send(res, failure("INVALID_INPUT", "\u8DEF\u5F84\u4E0E\u7F16\u53F7\u4E0D\u4E00\u81F4"));
          return;
        }
        const input = { ...parsed.data, [field]: id };
        send(res, decision ? await service.decide(token, decision[2], input) : groupDecision ? await service.decideGroup(token, groupDecision[2], input) : contact2[2] === "company" ? await service.companyUpdate(token, input) : contact2[2] === "update" ? await service.contactUpdate(token, input) : await service.contactFollowup(token, input));
        return;
      }
    }
    send(res, failure("NOT_FOUND", "\u8054\u7CFB\u4EBA\u63A5\u53E3\u4E0D\u5B58\u5728"));
  };
}

// server/transport/contact-mail-http.ts
function createContactMailHandler(service) {
  return async (request2, response) => {
    const url = new URL(request2.url ?? "/", "http://localhost");
    if (request2.method !== "POST" || url.pathname !== CONTACT_MAIL_ROUTE) {
      send(response, failure("NOT_FOUND", "\u90AE\u4EF6\u4E8B\u4EF6\u63A5\u53E3\u4E0D\u5B58\u5728"));
      return;
    }
    if (url.search) {
      send(response, failure("INVALID_INPUT", "\u90AE\u4EF6\u4E8B\u4EF6\u4E0D\u63A5\u53D7\u67E5\u8BE2\u53C2\u6570"));
      return;
    }
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request2.headers.authorization ?? "")?.[1] ?? "";
    if (!token) {
      send(response, failure("UNAUTHORIZED", "\u4F1A\u8BDD\u65E0\u6548"));
      return;
    }
    const parsed = await body(request2, CONTACT_MAIL_LIMITS.bodyBytes);
    send(response, parsed.ok ? await service.record(token, parsed.data) : parsed);
  };
}

// server/transport/crm-http.ts
function createCrmHandler(service) {
  return async (request2, response) => {
    const url = new URL(request2.url ?? "/", `http://${request2.headers.host}`), path4 = url.pathname, method = request2.method;
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request2.headers.authorization ?? "")?.[1] ?? "";
    if (method === "GET" && path4 === CENTER_CONTACT_ROUTE) {
      const query = {};
      for (const [key, value2] of url.searchParams) {
        if (key in query) {
          send(response, failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u67E5\u8BE2\u53C2\u6570\u91CD\u590D"));
          return;
        }
        query[key] = ["limit", "offset"].includes(key) ? Number(value2) : key === "followupOnly" ? value2 === "true" ? true : value2 === "false" ? false : value2 : value2;
      }
      send(response, await service.contacts(token, query));
      return;
    }
    if (method === "GET" && path4 === CENTER_CONTACT_GROUP_ROUTE) {
      const query = {};
      for (const [key, value2] of url.searchParams) {
        if (key in query) {
          send(response, failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u5206\u7EC4\u67E5\u8BE2\u53C2\u6570\u91CD\u590D"));
          return;
        }
        query[key] = ["limit", "offset"].includes(key) ? Number(value2) : value2;
      }
      send(response, await service.contactGroups(token, query));
      return;
    }
    if (method === "GET" && path4 === LEAD_ROUTES.members) {
      send(response, await service.members(token, { search: url.searchParams.get("search") ?? "", limit: Number(url.searchParams.get("limit") ?? LEAD_LIMITS.page), offset: Number(url.searchParams.get("offset") ?? 0) }));
      return;
    }
    if (method === "GET" && path4 === LEAD_ROUTES.bootstrap) {
      send(response, await service.bootstrap(token));
      return;
    }
    if (method === "GET" && path4 === LEAD_ROUTES.leads) {
      send(response, await service.list(token, { view: url.searchParams.get("view") ?? "mine", search: url.searchParams.get("search") ?? "", limit: Number(url.searchParams.get("limit") ?? LEAD_LIMITS.page), offset: Number(url.searchParams.get("offset") ?? 0), ...url.searchParams.has("assignment") ? { assignment: url.searchParams.get("assignment") } : {}, ...url.searchParams.has("followupOnly") ? { followupOnly: url.searchParams.get("followupOnly") === "true" ? true : url.searchParams.get("followupOnly") === "false" ? false : url.searchParams.get("followupOnly") } : {}, ...url.searchParams.has("stage") ? { stage: url.searchParams.get("stage") } : {} }));
      return;
    }
    const detail = /^\/api\/crm\/leads\/([^/]+)$/.exec(path4);
    if (method === "GET" && detail) {
      send(response, await service.detail(token, detail[1]));
      return;
    }
    if (method === "POST") {
      const input = await body(request2, LEAD_LIMITS.bodyBytes);
      if (!input.ok) {
        send(response, input);
        return;
      }
      if (path4 === LEAD_ROUTES.leads) {
        send(response, await service.createCustomer(token, input.data));
        return;
      }
      if (path4 === LEAD_ROUTES.imports) {
        send(response, await service.importRows(token, input.data));
        return;
      }
      if (path4 === WORKBOOK_IMPORT_ROUTE) {
        send(response, await service.importWorkbook(token, input.data));
        return;
      }
      const publish = /^\/api\/crm\/imports\/([^/]+)\/publish$/.exec(path4);
      if (publish) {
        send(response, await service.publish(token, publish[1], input.data));
        return;
      }
      const action = /^\/api\/crm\/leads\/([^/]+)\/(claim|followups|update|assign)$/.exec(path4);
      if (action) {
        if (!input.data || typeof input.data !== "object" || Array.isArray(input.data) || "customerId" in input.data && input.data.customerId !== action[1]) {
          send(response, failure("INVALID_INPUT", "\u8DEF\u5F84\u4E0E\u5BA2\u6237\u7F16\u53F7\u4E0D\u4E00\u81F4"));
          return;
        }
        const v = { ...input.data, customerId: action[1] };
        send(response, action[2] === LEAD_ROUTES.assignAction ? await service.assign(token, v) : action[2] === "claim" ? await service.claim(token, v) : action[2] === "update" ? await service.updateCustomer(token, v) : await service.followup(token, v));
        return;
      }
    }
    send(response, failure("NOT_FOUND", "CRM\u63A5\u53E3\u4E0D\u5B58\u5728"));
  };
}

// server/adapters/postgres/notification-repository.ts
var import_node_crypto15 = require("node:crypto");

// server/adapters/postgres/assignment-schema.ts
var ASSIGNMENT_VERSION = "009-directed-assignment-public";
var ASSIGNMENT_SQL = `ALTER TABLE public.identity_outbox ADD COLUMN recipient_user_ids uuid[];`;

// server/core/notifications.ts
var NOTIFICATION_ROUTES = { feed: "/api/crm/notifications", events: "/api/crm/events", readAll: "/api/crm/notifications/read-all" };
var NOTIFICATION_LIMITS = { page: 50, pageMax: 100, history: 100, scanMax: 500, dispatchBatch: 50, deviceMax: 80, cursorDigits: 19, poll_ms: 1e3, stream_poll_ms: 2e3, stream_max: 32, buffer_bytes: 16384 };
var NOTIFICATION_CURSOR_MAX = 9223372036854775807n;

// server/adapters/postgres/notification-schema.ts
var NOTIFICATION_VERSION = "006-notification-m2-public";
var NOTIFICATION_LOCK = 19041006;
var NOTIFICATION_SQL = `
ALTER TABLE public.identity_outbox ADD COLUMN payload jsonb NOT NULL DEFAULT '{}';
CREATE TABLE crm_notification_consumed(event_id uuid PRIMARY KEY REFERENCES public.identity_outbox(event_id),consumed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE crm_feed_heads(user_id uuid PRIMARY KEY REFERENCES public.identity_users(user_id),delivery_seq bigint NOT NULL DEFAULT 0 CHECK(delivery_seq>=0));
CREATE TABLE crm_event_deliveries(
 delivery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id uuid NOT NULL REFERENCES public.identity_outbox(event_id),
 recipient_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),projection_type text NOT NULL CHECK(projection_type='lead'),
 delivery_seq bigint NOT NULL CHECK(delivery_seq>0),customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
 event_type text NOT NULL,version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(event_id,recipient_user_id,projection_type),UNIQUE(recipient_user_id,delivery_seq));
CREATE TABLE crm_device_cursors(user_id uuid NOT NULL REFERENCES public.identity_users(user_id),device_id text NOT NULL,cursor bigint NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,device_id));
CREATE TABLE crm_notification_reads(user_id uuid NOT NULL REFERENCES public.identity_users(user_id),delivery_id uuid NOT NULL REFERENCES crm_event_deliveries(delivery_id),read_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,delivery_id));
`;

// server/core/tasks.ts
var TASK_ROUTES = { tasks: "/api/crm/tasks", rescheduleAction: "reschedule", completeAction: "complete" };
var TASK_LIMITS = { title: 500, feedback: 2e4, key: 128, page: 25, pageMax: 100, dueBatch: 50, dueBatchMax: 100, poll_seconds: 5 };
var TASK_DUE_EVENT = "crm.task.due";
var TIME_LIMITS2 = { hours: 24, minutes: 60, seconds: 60 };
function validTaskTime(value2) {
  if (typeof value2 !== "string")
    return false;
  const p = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value2);
  if (!p)
    return false;
  const [, year, month, day, hour, minute, second, , oh, om] = p;
  const d = /* @__PURE__ */ new Date(`${year}-${month}-${day}T00:00:00Z`);
  return d.getUTCFullYear() === Number(year) && d.getUTCMonth() + 1 === Number(month) && d.getUTCDate() === Number(day) && Number(hour) < TIME_LIMITS2.hours && Number(minute) < TIME_LIMITS2.minutes && Number(second) < TIME_LIMITS2.seconds && (oh === void 0 || Number(oh) < TIME_LIMITS2.hours && Number(om) < TIME_LIMITS2.minutes) && Number.isFinite(Date.parse(value2));
}

// server/core/opportunities.ts
var OPPORTUNITY_ROUTES = { opportunities: "/api/crm/opportunities", stageAction: "stage" };
var OPPORTUNITY_LIMITS = { title: 500, description: 2e4, route: 128, source: 500, evidence: 4096, reason: 2e3, key: 128, page: 25, pageMax: 100, amountWholeDigits: 12, amountFractionDigits: 2 };
var OPPORTUNITY_STAGES = ["inquiry", "quote_sent", "negotiation", "booking_confirmed", "closed_won", "closed_lost"];
var OPPORTUNITY_EVENTS = { created: "crm.opportunity.created", stageChanged: "crm.opportunity.stage_changed" };

// server/adapters/postgres/task-repository.ts
var import_node_crypto14 = require("node:crypto");

// server/adapters/postgres/task-schema.ts
var TASK_VERSION = "017-followup-tasks-public";
var TASK_LOCK = 19041017;
var TASK_SQL = `
CREATE TABLE crm_followup_tasks (
 task_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
 title text NOT NULL CHECK(btrim(title)<>'' AND length(title)<=${TASK_LIMITS.title}),due_at timestamptz NOT NULL CHECK(isfinite(due_at)),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed')),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by uuid NOT NULL REFERENCES public.identity_users(user_id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,completed_by uuid REFERENCES public.identity_users(user_id),feedback text,
 CHECK((status='open' AND completed_at IS NULL AND completed_by IS NULL AND feedback IS NULL) OR (status='completed' AND completed_at IS NOT NULL AND completed_by IS NOT NULL AND feedback IS NOT NULL AND btrim(feedback)<>'' AND length(feedback)<=${TASK_LIMITS.feedback}))
);
CREATE INDEX idx_crm_tasks_customer ON crm_followup_tasks(customer_id,due_at,task_id);
CREATE INDEX idx_crm_tasks_due ON crm_followup_tasks(due_at,task_id) WHERE status='open';
CREATE TABLE crm_task_due_receipts (
 task_id uuid NOT NULL REFERENCES crm_followup_tasks(task_id),task_version integer NOT NULL CHECK(task_version>0),
 responsible_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),event_id uuid NOT NULL UNIQUE REFERENCES public.identity_outbox(event_id),
 PRIMARY KEY(task_id,task_version)
);
CREATE FUNCTION crm_tasks_customer_owner_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
  UPDATE crm_followup_tasks SET version=version+1,updated_at=clock_timestamp() WHERE customer_id=NEW.customer_id AND status='open';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_tasks_customer_owner_changed AFTER UPDATE OF owner_user_id ON crm_customers FOR EACH ROW EXECUTE FUNCTION crm_tasks_customer_owner_changed();
`;

// server/adapters/postgres/task-repository.ts
var UUID7 = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function administrator2(a) {
  return a.roles.includes("admin") && ["shared", "summary"].includes(a.scope) && a.capabilities.includes("leads.read.all");
}
function operations(a) {
  return a.roles.includes("operations") && ["shared", "summary"].includes(a.scope) && a.capabilities.includes("followups.read");
}
function canSee(a, c) {
  return administrator2(a) || operations(a) && c.origin === "operations" || c.owner_user_id === a.userId && a.capabilities.includes("leads.develop");
}
function canManage(a, c) {
  return a.capabilities.includes("leads.develop") && (administrator2(a) || operations(a) && c.origin === "operations" && c.owner_user_id === null || c.owner_user_id === a.userId && canSee(a, c));
}
async function access(db, userId) {
  const r = await db.query(`SELECT u.user_id,a.scope,a.capabilities,ARRAY(SELECT g.role FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active) AS roles FROM public.identity_users u JOIN public.identity_product_access a ON a.user_id=u.user_id AND a.product_id='crm' AND a.active WHERE u.user_id=$1 AND u.active AND NOT u.must_change_password`, [userId]);
  if (!r.rows.length)
    return null;
  const row2 = r.rows[0], roles = row2.roles;
  if (!roles.length)
    return null;
  return { userId: row2.user_id, roles, scope: row2.scope, capabilities: effectiveCapabilitiesFor(roles, row2.capabilities) };
}
async function canProjectTaskDue(db, event3, a) {
  const p = event3.payload;
  if (!p || typeof p.taskId !== "string" || !UUID7.test(p.taskId) || !Number.isSafeInteger(p.taskVersion) || typeof p.dueAt !== "string" || typeof p.responsibleUserId !== "string" || !event3.recipient_user_ids?.includes(a.userId))
    return false;
  const r = await db.query(`SELECT c.*,t.version AS task_version,t.due_at,t.status,COALESCE(c.owner_user_id,c.created_by) AS responsible_user_id FROM crm_followup_tasks t JOIN crm_customers c USING(customer_id) WHERE t.task_id=$1 AND c.customer_id=$2 AND t.due_at<=clock_timestamp()`, [p.taskId, event3.customer_id]);
  const row2 = r.rows[0];
  if (!row2 || row2.status !== "open" || row2.task_version !== p.taskVersion || new Date(row2.due_at).toISOString() !== p.dueAt || row2.responsible_user_id !== p.responsibleUserId || row2.responsible_user_id !== a.userId)
    return false;
  const current = await access(db, a.userId);
  return !!current && canManage(current, row2);
}
var COLUMNS = `t.opportunity_id AS "opportunityId",(SELECT op.title FROM crm_opportunities op WHERE op.opportunity_id=t.opportunity_id AND op.customer_id=t.customer_id) AS "opportunityTitle",t.task_id AS "taskId",t.customer_id AS "customerId",t.title,t.due_at AS "dueAt",t.status,t.version,t.created_by AS "createdBy",t.created_at AS "createdAt",t.updated_at AS "updatedAt",t.completed_at AS "completedAt",t.completed_by AS "completedBy",t.feedback,COALESCE(c.owner_user_id,c.created_by) AS "responsibleUserId",u.display_name AS "responsibleName"`;
function taskRow(r, manage2) {
  return { ...r, dueAt: r.dueAt.toISOString(), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), completedAt: r.completedAt instanceof Date ? r.completedAt.toISOString() : null, canManage: manage2 };
}
var PostgresTaskRepository = class {
  constructor(pool, log) {
    this.pool = pool;
    this.log = log;
    assertCenterDatabasePool(pool);
  }
  async tx(fn) {
    let db;
    try {
      db = await this.pool.connect();
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK]);
      await db.query("SELECT pg_advisory_xact_lock($1)", [TASK_LOCK]);
      const result2 = await fn(db);
      await db.query(result2.ok ? "COMMIT" : "ROLLBACK");
      return result2;
    } catch (error) {
      if (db)
        try {
          await db.query("ROLLBACK");
        } catch (rollbackError) {
          this.log.write("ERROR", "tasks.rollback", `\u4EFB\u52A1\u56DE\u6EDA\u5931\u8D25 ${rollbackError instanceof Error ? rollbackError.stack ?? rollbackError.message : "UNKNOWN"}`);
        }
      this.log.write("ERROR", "tasks.pg", `\u4EFB\u52A1\u6570\u636E\u5E93\u64CD\u4F5C\u5931\u8D25 code=${error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN"} ${error instanceof Error ? error.stack ?? error.message : "UNKNOWN"}`);
      return failure("DATABASE_ERROR", "\u4EFB\u52A1\u670D\u52A1\u6682\u4E0D\u53EF\u7528");
    } finally {
      db?.release();
    }
  }
  async actor(db, hash) {
    const u = await db.query(`SELECT u.user_id FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) WHERE s.token_hash=$1 AND s.client='api' AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND NOT u.must_change_password AND s.security_revision=u.security_revision`, [hash]);
    return u.rows.length ? access(db, u.rows[0].user_id) : null;
  }
  async authorized(hash, fn) {
    return this.tx(async (db) => {
      const a = await this.actor(db, hash);
      return a ? fn(db, a) : failure("UNAUTHORIZED", "CRM\u4F1A\u8BDD\u6216\u4EA7\u54C1\u51C6\u5165\u5DF2\u5931\u6548");
    });
  }
  async customer(db, id) {
    const r = await db.query("SELECT customer_id,created_by,owner_user_id,origin,state,version FROM crm_customers WHERE customer_id=$1 FOR SHARE", [id]);
    return r.rows[0];
  }
  async one(db, id, a, lock = false) {
    const r = await db.query(`SELECT ${COLUMNS} FROM crm_followup_tasks t JOIN crm_customers c USING(customer_id) JOIN public.identity_users u ON u.user_id=COALESCE(c.owner_user_id,c.created_by) WHERE t.task_id=$1 ${lock ? "FOR UPDATE OF t" : ""}`, [id]);
    if (!r.rows.length)
      return failure("NOT_FOUND", "\u4EFB\u52A1\u4E0D\u5B58\u5728");
    const c = await this.customer(db, r.rows[0].customerId);
    if (!c || !canSee(a, c))
      return failure("NOT_FOUND", "\u4EFB\u52A1\u4E0D\u5B58\u5728");
    return success(taskRow(r.rows[0], canManage(a, c)));
  }
  async cached(db, a, operation, input, fn) {
    const digest = (0, import_node_crypto14.createHash)("sha256").update(JSON.stringify(input)).digest("hex");
    const old = await db.query("SELECT digest,response FROM crm_lead_idempotency WHERE actor_id=$1 AND operation=$2 AND key=$3", [a.userId, operation, input.idempotencyKey]);
    if (old.rows.length) {
      if (old.rows[0].digest !== digest)
        return failure("CONFLICT", "\u5E42\u7B49\u952E\u5DF2\u7528\u4E8E\u4E0D\u540C\u8BF7\u6C42");
      return this.one(db, old.rows[0].response.taskId, a);
    }
    const result2 = await fn();
    if (result2.ok)
      await db.query("INSERT INTO crm_lead_idempotency(actor_id,operation,key,digest,response) VALUES($1,$2,$3,$4,$5)", [a.userId, operation, input.idempotencyKey, digest, JSON.stringify({ taskId: result2.data.taskId })]);
    return result2;
  }
  async migrate() {
    return this.tx(async (db) => {
      const old = await db.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [TASK_VERSION]);
      const hash = (0, import_node_crypto14.createHash)("sha256").update(TASK_SQL).digest("hex");
      if (old.rows.length && old.rows[0].checksum !== hash)
        return failure("CONFLICT", "\u4EFB\u52A1\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!old.rows.length) {
        await db.query(TASK_SQL);
        await db.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [TASK_VERSION, hash]);
      }
      return success(void 0);
    });
  }
  create(hash, input) {
    return this.authorized(hash, async (db, a) => {
      const c = await this.customer(db, input.customerId);
      if (!c || !canSee(a, c))
        return failure("NOT_FOUND", "\u5BA2\u6237\u4E0D\u5B58\u5728");
      if (!canManage(a, c))
        return failure("FORBIDDEN", "\u53EA\u80FD\u5904\u7406\u81EA\u8EAB\u4EFB\u52A1");
      return this.cached(db, a, `task:create:${input.customerId}`, input, async () => {
        if (c.version !== input.expectedCustomerVersion)
          return failure("CONFLICT", "\u5BA2\u6237\u7248\u672C\u5DF2\u53D8\u5316");
        if (input.opportunityId) {
          const opportunity = await db.query("SELECT opportunity_id FROM crm_opportunities WHERE opportunity_id=$1 AND customer_id=$2", [input.opportunityId, input.customerId]);
          if (!opportunity.rows.length)
            return failure("INVALID_INPUT", "\u5546\u673A\u4E0D\u5C5E\u4E8E\u5F53\u524D\u5BA2\u6237");
        }
        const responsible = c.owner_user_id ?? c.created_by, member = await access(db, responsible);
        if (!member || !canManage(member, c))
          return failure("CONFLICT", "\u4EFB\u52A1\u8D1F\u8D23\u4EBA\u5DF2\u505C\u7528\u6216\u65E0\u5F00\u53D1\u6743\u9650");
        const r = await db.query(`INSERT INTO crm_followup_tasks(customer_id,title,due_at,created_by,opportunity_id) VALUES($1,$2,$3,$4,$5) RETURNING task_id`, [input.customerId, input.title.trim(), input.dueAt, a.userId, input.opportunityId ?? null]);
        return this.one(db, r.rows[0].task_id, a);
      });
    });
  }
  list(hash, input) {
    return this.authorized(hash, async (db, a) => {
      const owner = a.capabilities.includes("leads.develop"), ops = operations(a);
      const visibility2 = administrator2(a) ? "($1::uuid IS NOT NULL)" : ops ? `(c.origin='operations'${owner ? " OR c.owner_user_id=$1" : ""})` : owner ? "c.owner_user_id=$1" : "FALSE AND $1::uuid IS NOT NULL";
      const filter = `WHERE (${visibility2}) AND ($2::uuid IS NULL OR c.customer_id=$2) AND ($3::text IS NULL OR t.status=$3)`;
      const params = [a.userId, input.customerId ?? null, input.status ?? null];
      const count = await db.query(`SELECT count(*)::int AS n FROM crm_followup_tasks t JOIN crm_customers c USING(customer_id) ${filter}`, params);
      const rows = await db.query(`SELECT ${COLUMNS},c.created_by,c.owner_user_id,c.origin,c.state FROM crm_followup_tasks t JOIN crm_customers c USING(customer_id) JOIN public.identity_users u ON u.user_id=COALESCE(c.owner_user_id,c.created_by) ${filter} ORDER BY CASE WHEN t.status='open' THEN 0 ELSE 1 END,t.due_at,t.task_id LIMIT $4 OFFSET $5`, [...params, input.limit, input.offset]);
      return success({ items: rows.rows.map((r) => {
        const manage2 = canManage(a, r);
        delete r.created_by;
        delete r.owner_user_id;
        delete r.origin;
        delete r.state;
        return taskRow(r, manage2);
      }), total: count.rows[0].n });
    });
  }
  detail(hash, id) {
    return this.authorized(hash, (db, a) => this.one(db, id, a));
  }
  reschedule(hash, input) {
    return this.authorized(hash, async (db, a) => {
      const existing = await this.one(db, input.taskId, a, true);
      if (!existing.ok)
        return existing;
      if (!existing.data.canManage)
        return failure("FORBIDDEN", "\u53EA\u80FD\u5904\u7406\u81EA\u8EAB\u4EFB\u52A1");
      return this.cached(db, a, `task:reschedule:${input.taskId}`, input, async () => {
        const r = await db.query(`UPDATE crm_followup_tasks SET due_at=$2,version=version+1,updated_at=clock_timestamp() WHERE task_id=$1 AND status='open' AND version=$3 RETURNING task_id`, [input.taskId, input.dueAt, input.expectedVersion]);
        if (!r.rows.length)
          return failure("CONFLICT", "\u4EFB\u52A1\u5DF2\u5B8C\u6210\u6216\u7248\u672C\u5DF2\u53D8\u5316");
        return this.one(db, input.taskId, a);
      });
    });
  }
  complete(hash, input) {
    return this.authorized(hash, async (db, a) => {
      const existing = await this.one(db, input.taskId, a, true);
      if (!existing.ok)
        return existing;
      if (!existing.data.canManage)
        return failure("FORBIDDEN", "\u53EA\u80FD\u5904\u7406\u81EA\u8EAB\u4EFB\u52A1");
      return this.cached(db, a, `task:complete:${input.taskId}`, input, async () => {
        const r = await db.query(`UPDATE crm_followup_tasks SET status='completed',feedback=$2,completed_at=clock_timestamp(),completed_by=$3,version=version+1,updated_at=clock_timestamp() WHERE task_id=$1 AND status='open' AND version=$4 RETURNING task_id`, [input.taskId, input.feedback.trim(), a.userId, input.expectedVersion]);
        if (!r.rows.length)
          return failure("CONFLICT", "\u4EFB\u52A1\u5DF2\u5B8C\u6210\u6216\u7248\u672C\u5DF2\u53D8\u5316");
        return this.one(db, input.taskId, a);
      });
    });
  }
  async processDue(limit) {
    return this.tx(async (db) => {
      const rows = await db.query(`SELECT t.task_id,t.customer_id,t.opportunity_id,t.version,t.due_at,c.version AS customer_version,COALESCE(c.owner_user_id,c.created_by) AS responsible_user_id FROM crm_followup_tasks t JOIN crm_customers c USING(customer_id) JOIN public.identity_users u ON u.user_id=COALESCE(c.owner_user_id,c.created_by) JOIN public.identity_product_access a ON a.user_id=u.user_id AND a.product_id='crm' AND a.active WHERE t.status='open' AND t.due_at<=clock_timestamp() AND u.active AND NOT u.must_change_password AND EXISTS(SELECT 1 FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active AND g.role IN ('admin','operations','sales')) AND (a.capabilities IS NULL OR a.capabilities ? 'leads.develop') AND (c.owner_user_id=u.user_id OR c.owner_user_id IS NULL AND a.scope IN ('shared','summary') AND EXISTS(SELECT 1 FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active AND (g.role='admin' AND (a.capabilities IS NULL OR a.capabilities ? 'leads.read.all') OR g.role='operations' AND (a.capabilities IS NULL OR a.capabilities ? 'followups.read')))) AND NOT EXISTS(SELECT 1 FROM crm_task_due_receipts d WHERE d.task_id=t.task_id AND d.task_version=t.version) ORDER BY t.due_at,t.task_id LIMIT $1 FOR UPDATE OF t SKIP LOCKED`, [limit]);
      let count = 0;
      for (const r of rows.rows) {
        const c = await this.customer(db, r.customer_id), member = await access(db, r.responsible_user_id);
        if (!c || !member || !canManage(member, c))
          continue;
        const event3 = await db.query(`INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES($1,$2,'crm',$3,$4,$5,$6::uuid[]) RETURNING event_id`, [TASK_DUE_EVENT, r.responsible_user_id, r.version, r.customer_id, JSON.stringify({ customerId: r.customer_id, version: r.customer_version, taskId: r.task_id, ...r.opportunity_id ? { opportunityId: r.opportunity_id } : {}, taskVersion: r.version, dueAt: new Date(r.due_at).toISOString(), responsibleUserId: r.responsible_user_id }), [r.responsible_user_id]]);
        await db.query("INSERT INTO crm_task_due_receipts(task_id,task_version,responsible_user_id,event_id) VALUES($1,$2,$3,$4)", [r.task_id, r.version, r.responsible_user_id, event3.rows[0].event_id]);
        count++;
      }
      return success(count);
    });
  }
};

// server/adapters/postgres/notification-repository.ts
var CONTACT_EVENTS = [...Object.values(CONTACT_ASSIGNMENT_EVENTS), ...Object.values(CONTACT_SHARING_EVENTS)];
var CONTACT_REQUEST_EVENTS = [CONTACT_ASSIGNMENT_EVENTS.requested, CONTACT_ASSIGNMENT_EVENTS.accepted, CONTACT_ASSIGNMENT_EVENTS.rejected, CONTACT_ASSIGNMENT_EVENTS.cancelled, ...Object.values(CONTACT_SHARING_EVENTS)];
var OPPORTUNITY_EVENT_TYPES = Object.values(OPPORTUNITY_EVENTS);
var SUMMARY_NOTE_MAX = 160;
var SELF_CREATED_EVENT = "crm.customer.created";
function visible(a, c, eventType) {
  if (a.roles.includes("admin") && ["shared", "summary"].includes(a.scope) && a.capabilities.includes("leads.read.all"))
    return true;
  if (eventType === "crm.lead.followup" || OPPORTUNITY_EVENT_TYPES.includes(eventType)) {
    return c.origin === "operations" && a.roles.includes("operations") && a.capabilities.includes("followups.read") && ["shared", "summary"].includes(a.scope) || c.owner_user_id === a.userId && a.capabilities.includes("leads.develop");
  }
  const ops = c.origin === "operations" && a.roles.includes("operations") && a.capabilities.some((v) => ["leads.import", "leads.publish", "followups.read"].includes(v)) && (a.scope === "shared" || a.scope === "summary");
  const sales = c.state === "published" && a.capabilities.includes("leads.claim") || c.owner_user_id === a.userId && a.capabilities.includes("leads.develop");
  return ops || sales;
}
var PostgresNotificationRepository = class {
  constructor(pool, log) {
    this.pool = pool;
    this.log = log;
    assertCenterDatabasePool(pool);
  }
  async tx(fn) {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK]);
      const r = await fn(db);
      await db.query(r.ok ? "COMMIT" : "ROLLBACK");
      return r;
    } catch (e) {
      try {
        await db.query("ROLLBACK");
      } catch {
        this.log.write("ERROR", "notifications.rollback", "\u901A\u77E5\u56DE\u6EDA\u5931\u8D25");
      }
      this.log.write("ERROR", "notifications.pg", "\u901A\u77E5\u6570\u636E\u5E93\u64CD\u4F5C\u5931\u8D25");
      return failure("DATABASE_ERROR", "\u901A\u77E5\u670D\u52A1\u6682\u4E0D\u53EF\u7528");
    } finally {
      db.release();
    }
  }
  async migrate() {
    return this.tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock($1)", [NOTIFICATION_LOCK]);
      const sum = (0, import_node_crypto15.createHash)("sha256").update(NOTIFICATION_SQL).digest("hex");
      const old = await db.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [NOTIFICATION_VERSION]);
      if (old.rows.length && old.rows[0].checksum !== sum)
        return failure("CONFLICT", "\u901A\u77E5\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!old.rows.length) {
        await db.query(NOTIFICATION_SQL);
        await db.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [NOTIFICATION_VERSION, sum]);
      }
      const nextSum = (0, import_node_crypto15.createHash)("sha256").update(ASSIGNMENT_SQL).digest("hex");
      const next = await db.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [ASSIGNMENT_VERSION]);
      if (next.rows.length && next.rows[0].checksum !== nextSum)
        return failure("CONFLICT", "\u5206\u914D\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!next.rows.length) {
        await db.query(ASSIGNMENT_SQL);
        await db.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [ASSIGNMENT_VERSION, nextSum]);
      }
      return success(void 0);
    });
  }
  async actor(db, hash) {
    const user = await db.query(`SELECT u.user_id,u.must_change_password FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) WHERE s.token_hash=$1 AND s.client='api' AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND s.security_revision=u.security_revision FOR SHARE OF s,u`, [hash]);
    if (!user.rows.length)
      return failure("UNAUTHORIZED", "\u4F1A\u8BDD\u5DF2\u5931\u6548");
    if (user.rows[0].must_change_password)
      return failure("PASSWORD_CHANGE_REQUIRED", "\u8BF7\u5148\u4FEE\u6539\u5BC6\u7801");
    const actor = await this.access(db, user.rows[0].user_id);
    return actor ? success(actor) : failure("FORBIDDEN", "\u65E0CRM\u51C6\u5165");
  }
  async access(db, userId) {
    const access2 = await db.query("SELECT scope,capabilities FROM public.identity_product_access WHERE user_id=$1 AND product_id='crm' AND active FOR SHARE", [userId]);
    if (!access2.rows.length)
      return null;
    const roles = await db.query("SELECT role FROM public.identity_product_grants WHERE user_id=$1 AND product_id='crm' AND active FOR SHARE", [userId]);
    const list = roles.rows.map((r) => r.role);
    if (!list.length)
      return null;
    const explicit = access2.rows[0].capabilities;
    const capabilities = effectiveCapabilitiesFor(list, explicit);
    if (!capabilities.length)
      return null;
    return { userId, roles: list, scope: access2.rows[0].scope, capabilities };
  }
  async contactAccess(db, a, contactId, customerId) {
    if (!Number.isSafeInteger(contactId))
      return false;
    const row2 = await contact(db, { contactId: Number(contactId), customerId });
    return !!row2 && read(a, row2);
  }
  async watermark(hash) {
    return this.tx(async (db) => {
      const a = await this.actor(db, hash);
      if (!a.ok)
        return a;
      const rows = await db.query("SELECT delivery_seq::text FROM crm_feed_heads WHERE user_id=$1", [a.data.userId]);
      return success(rows.rows[0]?.delivery_seq ?? "0");
    });
  }
  async feed(hash, q) {
    return this.tx(async (db) => {
      const actor = await this.actor(db, hash);
      if (!actor.ok)
        return actor;
      const a = actor.data;
      const head = await db.query("SELECT delivery_seq::text FROM crm_feed_heads WHERE user_id=$1", [a.userId]);
      const high = head.rows[0]?.delivery_seq ?? "0";
      if (BigInt(q.after) > BigInt(high))
        return success({ items: [], nextCursor: high, hasMore: false, resyncRequired: true });
      const after = q.latest ? String(BigInt(high) > BigInt(NOTIFICATION_LIMITS.history) ? BigInt(high) - BigInt(NOTIFICATION_LIMITS.history) : 0) : q.after;
      const rows = await db.query(`SELECT d.*,c.created_by,c.owner_user_id,c.origin,c.state,co.name AS company_name,o.recipient_user_ids,o.payload,u.display_name AS actor_name,act.note AS activity_note,act.opportunity_id AS activity_opportunity_id,op.opportunity_id AS projected_opportunity_id,op.title AS opportunity_title,EXISTS(SELECT 1 FROM crm_notification_reads r WHERE r.user_id=$1 AND r.delivery_id=d.delivery_id) AS read FROM crm_event_deliveries d JOIN crm_customers c USING(customer_id) JOIN public.identity_outbox o ON o.event_id=d.event_id JOIN companies co ON co.id=c.company_id LEFT JOIN public.identity_users u ON u.user_id=o.user_id LEFT JOIN crm_shared_activities act ON act.customer_id=c.customer_id AND act.actor_id=o.user_id AND act.id::text=o.payload->>'activityId' AND o.event_type='crm.lead.followup' LEFT JOIN crm_opportunities op ON op.customer_id=c.customer_id AND op.opportunity_id::text=COALESCE(act.opportunity_id::text,o.payload->>'opportunityId') WHERE d.recipient_user_id=$1 AND d.delivery_seq>$2 AND d.delivery_seq<=$3 AND NOT(d.event_type=$5 AND o.user_id=$1) ORDER BY d.delivery_seq LIMIT $4 FOR SHARE OF c`, [a.userId, after, high, NOTIFICATION_LIMITS.scanMax, SELF_CREATED_EVENT]);
      const items = [];
      let cursor = q.after;
      for (const r of rows.rows) {
        cursor = String(r.delivery_seq);
        if (CONTACT_EVENTS.includes(r.event_type)) {
          if (!r.recipient_user_ids?.includes(a.userId))
            continue;
          const contactAccess = await this.contactAccess(db, a, r.payload?.contactId, r.customer_id);
          const requestEvent = CONTACT_REQUEST_EVENTS.includes(r.event_type);
          if (!requestEvent && !contactAccess)
            continue;
          const shareEvent = Object.values(CONTACT_SHARING_EVENTS).includes(r.event_type);
          const requestRow = requestEvent ? (await db.query(shareEvent ? "SELECT grantor_user_id AS actor_id,target_user_id,status FROM crm_contact_shares WHERE share_id=$1" : "SELECT actor_id,target_user_id,status FROM crm_contact_assignment_requests WHERE request_id=$1", [shareEvent ? r.payload.shareId : r.payload.requestId])).rows[0] : void 0;
          const canOpen = requestEvent ? !!requestRow && ([requestRow.actor_id, requestRow.target_user_id].includes(a.userId) || shareEvent && contactAccess) : contactAccess;
          items.push({ id: r.delivery_id, eventType: r.event_type, customerId: contactAccess ? r.customer_id : "", version: contactAccess ? r.version : 0, canOpen, cursor, createdAt: new Date(r.created_at).toISOString(), read: r.read, ...requestEvent ? shareEvent ? { shareId: r.payload.shareId, shareStatus: requestRow?.status, shareTargetUserId: requestRow?.target_user_id } : { requestId: r.payload.requestId, assignmentStatus: requestRow?.status, ...typeof r.payload.groupId === "string" ? { assignmentGroupId: r.payload.groupId } : {}, ...Number.isSafeInteger(r.payload.groupCount) ? { assignmentGroupCount: r.payload.groupCount } : {} } : {}, ...contactAccess ? { contactId: r.payload.contactId } : {}, summary: { companyName: r.company_name, actorName: r.actor_name, ...requestEvent ? { contactName: r.payload.contactName } : {} } });
          if (items.length === q.limit)
            break;
          continue;
        }
        const assigned = r.event_type === "crm.lead.assigned" && r.recipient_user_ids?.includes(a.userId);
        const taskDue = r.event_type === TASK_DUE_EVENT;
        if (taskDue && !await canProjectTaskDue(db, r, a))
          continue;
        if (taskDue || assigned || visible(a, r, r.event_type)) {
          const canOpen = assigned ? canReadLead(a, r) : true;
          items.push({ id: r.delivery_id, eventType: r.event_type, customerId: canOpen ? r.customer_id : "", version: canOpen ? r.version : 0, canOpen, cursor, createdAt: new Date(r.created_at).toISOString(), read: r.read, ...taskDue ? { taskId: r.payload.taskId } : {}, ...r.projected_opportunity_id && canOpen ? { opportunityId: r.projected_opportunity_id } : {}, ...canReadLead(a, r) ? { summary: { companyName: r.company_name, actorName: r.actor_name, ...typeof r.activity_note === "string" ? { note: r.activity_note.slice(0, SUMMARY_NOTE_MAX) } : OPPORTUNITY_EVENT_TYPES.includes(r.event_type) && r.opportunity_title ? { note: r.opportunity_title.slice(0, SUMMARY_NOTE_MAX) } : {} } } : {} });
          if (items.length === q.limit)
            break;
        }
      }
      if (!rows.rows.length || q.latest)
        cursor = high;
      await db.query(`INSERT INTO crm_device_cursors(user_id,device_id,cursor) VALUES($1,$2,$3) ON CONFLICT(user_id,device_id) DO UPDATE SET cursor=GREATEST(crm_device_cursors.cursor,excluded.cursor),updated_at=now()`, [a.userId, q.deviceId, cursor]);
      return success({ items, nextCursor: cursor, hasMore: BigInt(cursor) < BigInt(high) });
    });
  }
  async read(hash, id) {
    return this.tx(async (db) => {
      const actor = await this.actor(db, hash);
      if (!actor.ok)
        return actor;
      const rows = await db.query("SELECT c.*,d.event_type,o.recipient_user_ids,o.payload FROM crm_event_deliveries d JOIN crm_customers c USING(customer_id) JOIN public.identity_outbox o ON o.event_id=d.event_id WHERE d.delivery_id=$1 AND d.recipient_user_id=$2 FOR SHARE OF c", [id, actor.data.userId]);
      if (rows.rows[0]?.event_type === TASK_DUE_EVENT && !await canProjectTaskDue(db, rows.rows[0], actor.data))
        return failure("NOT_FOUND", "\u63D0\u9192\u5DF2\u5931\u6548");
      if (!rows.rows.length || !(CONTACT_REQUEST_EVENTS.includes(rows.rows[0].event_type) && rows.rows[0].recipient_user_ids?.includes(actor.data.userId)) && !(CONTACT_EVENTS.includes(rows.rows[0].event_type) && await this.contactAccess(db, actor.data, rows.rows[0].payload?.contactId, rows.rows[0].customer_id)) && !(rows.rows[0].event_type === "crm.lead.assigned" && rows.rows[0].recipient_user_ids?.includes(actor.data.userId)) && !visible(actor.data, rows.rows[0], rows.rows[0].event_type))
        return failure("NOT_FOUND", "\u901A\u77E5\u4E0D\u5B58\u5728");
      await db.query("INSERT INTO crm_notification_reads(user_id,delivery_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [actor.data.userId, id]);
      return success(void 0);
    });
  }
  async readAll(hash) {
    return this.tx(async (db) => {
      const actor = await this.actor(db, hash);
      if (!actor.ok)
        return actor;
      const result2 = await db.query(`INSERT INTO crm_notification_reads(user_id,delivery_id) SELECT $1,delivery_id FROM (SELECT delivery_id FROM crm_event_deliveries WHERE recipient_user_id=$1 ORDER BY delivery_seq DESC LIMIT $2) latest ON CONFLICT DO NOTHING`, [actor.data.userId, NOTIFICATION_LIMITS.history]);
      return success({ marked: result2.rowCount ?? 0 });
    });
  }
  async dispatch() {
    return this.tx(async (db) => {
      await db.query("SELECT pg_advisory_xact_lock($1)", [NOTIFICATION_LOCK]);
      const events = await db.query(`SELECT o.* FROM public.identity_outbox o WHERE NOT EXISTS(SELECT 1 FROM crm_notification_consumed x WHERE x.event_id=o.event_id) ORDER BY o.created_at,o.event_id LIMIT $1 FOR UPDATE OF o SKIP LOCKED`, [NOTIFICATION_LIMITS.dispatchBatch]);
      const recipients2 = await db.query("SELECT user_id FROM public.identity_users WHERE active AND NOT must_change_password ORDER BY user_id FOR SHARE");
      let count = 0;
      for (const event3 of events.rows) {
        if (event3.product_id === "crm" && ["crm.customer.created", "crm.lead.published", "crm.lead.claimed", "crm.lead.followup", "crm.lead.assigned", TASK_DUE_EVENT, ...OPPORTUNITY_EVENT_TYPES, ...CONTACT_EVENTS].includes(event3.event_type) && event3.customer_id) {
          const customer2 = await db.query("SELECT * FROM crm_customers WHERE customer_id=$1 FOR SHARE", [event3.customer_id]);
          if (customer2.rows.length)
            for (const user of recipients2.rows) {
              if (event3.event_type === SELF_CREATED_EVENT && event3.user_id === user.user_id)
                continue;
              if ([TASK_DUE_EVENT, "crm.lead.assigned", ...CONTACT_EVENTS].includes(event3.event_type) && !event3.recipient_user_ids?.includes(user.user_id))
                continue;
              const a = await this.access(db, user.user_id);
              if (!a)
                continue;
              if (event3.event_type === TASK_DUE_EVENT) {
                if (!await canProjectTaskDue(db, event3, a))
                  continue;
              } else if (CONTACT_EVENTS.includes(event3.event_type)) {
                if (!CONTACT_REQUEST_EVENTS.includes(event3.event_type) && !await this.contactAccess(db, a, event3.payload?.contactId, event3.customer_id))
                  continue;
              } else if (event3.event_type !== "crm.lead.assigned" && !visible(a, customer2.rows[0], event3.event_type))
                continue;
              const old = await db.query("SELECT 1 FROM crm_event_deliveries WHERE event_id=$1 AND recipient_user_id=$2 AND projection_type='lead'", [event3.event_id, a.userId]);
              if (old.rows.length)
                continue;
              await db.query("INSERT INTO crm_feed_heads(user_id) VALUES($1) ON CONFLICT DO NOTHING", [a.userId]);
              const head = await db.query("UPDATE crm_feed_heads SET delivery_seq=delivery_seq+1 WHERE user_id=$1 RETURNING delivery_seq", [a.userId]);
              await db.query("INSERT INTO crm_event_deliveries(event_id,recipient_user_id,projection_type,delivery_seq,customer_id,event_type,version) VALUES($1,$2,'lead',$3,$4,$5,$6)", [event3.event_id, a.userId, head.rows[0].delivery_seq, event3.customer_id, event3.event_type, Number.isSafeInteger(event3.payload?.version) ? event3.payload.version : event3.revision]);
              count++;
            }
        }
        await db.query("INSERT INTO crm_notification_consumed(event_id) VALUES($1) ON CONFLICT DO NOTHING", [event3.event_id]);
      }
      await db.query(`DELETE FROM crm_notification_reads r USING crm_event_deliveries d,crm_feed_heads h WHERE r.delivery_id=d.delivery_id AND d.recipient_user_id=h.user_id AND d.delivery_seq<=GREATEST(h.delivery_seq-$1,0)`, [NOTIFICATION_LIMITS.history]);
      await db.query(`DELETE FROM crm_event_deliveries d USING crm_feed_heads h WHERE d.recipient_user_id=h.user_id AND d.delivery_seq<=GREATEST(h.delivery_seq-$1,0)`, [NOTIFICATION_LIMITS.history]);
      return success(count);
    });
  }
};

// server/services/notifications.ts
var UUID8 = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
var DEVICE = new RegExp(`^[A-Za-z0-9_-]{1,${NOTIFICATION_LIMITS.deviceMax}}$`);
var CURSOR = new RegExp(`^(0|[1-9][0-9]{0,${NOTIFICATION_LIMITS.cursorDigits - 1}})$`);
function createNotificationService(repo, tokens) {
  return {
    async feed(token, input) {
      if (!input || typeof input.deviceId !== "string" || !DEVICE.test(input.deviceId) || typeof input.after !== "string" || !CURSOR.test(input.after) || BigInt(input.after) > NOTIFICATION_CURSOR_MAX || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > NOTIFICATION_LIMITS.pageMax || input.latest !== void 0 && typeof input.latest !== "boolean")
        return failure("INVALID_INPUT", "\u901A\u77E5\u5206\u9875\u53C2\u6570\u65E0\u6548");
      return repo.feed(tokens.hash(token), input);
    },
    async read(token, id) {
      return UUID8.test(id) ? repo.read(tokens.hash(token), id) : failure("INVALID_INPUT", "\u901A\u77E5\u6807\u8BC6\u65E0\u6548");
    },
    async readAll(token) {
      return repo.readAll(tokens.hash(token));
    },
    async watermark(token) {
      return repo.watermark(tokens.hash(token));
    }
  };
}

// server/transport/events-http.ts
function createEventsHandler(service) {
  let streams = 0;
  return async (request2, response) => {
    const url = new URL(request2.url ?? "/", "http://localhost"), path4 = url.pathname;
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request2.headers.authorization ?? "")?.[1] ?? "";
    if (!token) {
      send(response, failure("UNAUTHORIZED", "\u8BF7\u5148\u767B\u5F55"));
      return;
    }
    const latest = url.searchParams.get("latest");
    const query = { deviceId: url.searchParams.get("deviceId") ?? "", after: url.searchParams.get("after") ?? "0", limit: Number(url.searchParams.get("limit") ?? NOTIFICATION_LIMITS.page), ...latest === "true" ? { latest: true } : latest === "false" ? { latest: false } : {} };
    if (request2.method === "GET" && path4 === NOTIFICATION_ROUTES.feed) {
      send(response, await service.feed(token, query));
      return;
    }
    if (request2.method === "POST" && path4 === NOTIFICATION_ROUTES.readAll) {
      send(response, await service.readAll(token));
      return;
    }
    const read2 = /^\/api\/crm\/notifications\/([^/]+)\/read$/.exec(path4);
    if (request2.method === "POST" && read2) {
      send(response, await service.read(token, read2[1]));
      return;
    }
    if (request2.method !== "GET" || path4 !== NOTIFICATION_ROUTES.events) {
      send(response, failure("NOT_FOUND", "\u901A\u77E5\u63A5\u53E3\u4E0D\u5B58\u5728"));
      return;
    }
    if (streams >= NOTIFICATION_LIMITS.stream_max) {
      send(response, failure("RATE_LIMITED", "\u901A\u77E5\u8FDE\u63A5\u5DF2\u8FBE\u4E0A\u9650"));
      return;
    }
    const initial = await service.feed(token, { ...query, limit: 1 });
    if (!initial.ok) {
      send(response, initial);
      return;
    }
    if (streams >= NOTIFICATION_LIMITS.stream_max) {
      send(response, failure("RATE_LIMITED", "\u901A\u77E5\u8FDE\u63A5\u5DF2\u8FBE\u4E0A\u9650"));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Connection": "keep-alive" });
    request2.socket.setTimeout(0);
    streams++;
    let closed = false, timer, cursor = query.after;
    const close = () => {
      if (closed)
        return;
      closed = true;
      streams--;
      if (timer)
        clearTimeout(timer);
      response.end();
    };
    response.once("close", close);
    response.once("error", close);
    const tick = async () => {
      if (closed)
        return;
      try {
        const watermark = await service.watermark(token);
        if (closed)
          return;
        if (!watermark.ok) {
          close();
          return;
        }
        if (response.writableLength > NOTIFICATION_LIMITS.buffer_bytes) {
          close();
          return;
        }
        const frame = watermark.data !== cursor ? `event: change
data: ${JSON.stringify({ cursor: watermark.data })}

` : ": heartbeat\n\n";
        cursor = watermark.data;
        if (!response.write(frame)) {
          close();
          return;
        }
      } catch {
        close();
        return;
      }
      if (!closed) {
        timer = setTimeout(() => {
          void tick();
        }, NOTIFICATION_LIMITS.stream_poll_ms);
        timer.unref();
      }
    };
    await tick();
  };
}

// server/adapters/notification-dispatcher.ts
function startNotificationDispatcher(repo, log) {
  let stopped = false, timer, active;
  const tick = () => {
    if (stopped)
      return;
    active = (async () => {
      try {
        const result2 = await repo.dispatch();
        if (!result2.ok)
          log.write("WARN", "notifications.dispatch", "\u901A\u77E5\u6295\u9012\u6682\u4E0D\u53EF\u7528");
      } catch {
        log.write("ERROR", "notifications.dispatch", "\u901A\u77E5\u6295\u9012\u5931\u8D25");
      } finally {
        if (!stopped) {
          timer = setTimeout(tick, NOTIFICATION_LIMITS.poll_ms);
          timer.unref();
        }
      }
    })();
  };
  tick();
  return { async stop() {
    stopped = true;
    if (timer)
      clearTimeout(timer);
    await active;
  } };
}

// server/core/desktop-session.ts
var DESKTOP_AUTH_ROUTES = {
  register: "/api/auth/desktop/register",
  login: "/api/auth/desktop/login",
  refresh: "/api/auth/desktop/refresh",
  logout: "/api/auth/desktop/logout",
  me: "/api/auth/desktop/me",
  password: "/api/auth/desktop/password"
};
var DESKTOP_SESSION_LIMITS = { idle_seconds: 15 * 24 * 60 * 60, absolute_seconds: 90 * 24 * 60 * 60 };
var REGISTRATION_PRODUCTS = ["crm", "navigator"];

// server/services/desktop-session.ts
var MILLISECONDS_PER_SECOND11 = 1e3;
var TOKEN_PATTERN2 = /^[A-Za-z0-9_-]+$/;
var EMAIL_PATTERN2 = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
var unauthorized = () => failure("UNAUTHORIZED", "\u767B\u5F55\u4FE1\u606F\u65E0\u6548\u6216\u4F1A\u8BDD\u5DF2\u5931\u6548");
var validToken = (token) => typeof token === "string" && token.length === AUTH_LIMITS.tokenCharacters && TOKEN_PATTERN2.test(token);
function object2(input, keys7) {
  return input && typeof input === "object" && !Array.isArray(input) && !Object.keys(input).some((key) => !keys7.includes(key)) ? input : null;
}
function createDesktopSessionService(repo, passwords, tokens, clock, ttlSeconds, offlineIssuer) {
  const date = (seconds) => new Date(clock.now() + seconds * MILLISECONDS_PER_SECOND11).toISOString();
  function loginResponse(token, refreshToken, expiresAt, identity, absoluteExpiresAt) {
    try {
      const offlineAccess = identity.mustChangePassword ? void 0 : offlineIssuer?.issue(identity, clock.now(), Date.parse(absoluteExpiresAt ?? expiresAt));
      return success({ token, refreshToken, expiresAt, identity, ...offlineAccess ? { offlineAccess } : {} });
    } catch {
      return failure("UNAVAILABLE", "\u79BB\u7EBF\u6388\u6743\u6682\u4E0D\u53EF\u7528");
    }
  }
  async function me(token) {
    if (!validToken(token))
      return unauthorized();
    const identity = await repo.desktopIdentity(tokens.hash(token));
    return !identity.ok ? identity : identity.data ? success(identity.data) : unauthorized();
  }
  return {
    me,
    async register(input) {
      const value2 = object2(input, ["email", "password", "product"]);
      const product = value2?.product ?? "crm";
      if (!value2 || !isAccountEmail(value2.email) || !isNewAccountPassword(value2.password) || !REGISTRATION_PRODUCTS.includes(product))
        return failure("INVALID_INPUT", "\u8BF7\u8F93\u5165\u6709\u6548\u90AE\u7BB1\uFF0C\u5BC6\u7801\u81F3\u5C116\u4F4D\uFF0C\u4EC5\u5141\u8BB8\u82F1\u6587\u5B57\u6BCD\u548C\u6570\u5B57");
      if (!repo.createSalesAccount)
        return failure("UNAVAILABLE", "\u6CE8\u518C\u6682\u4E0D\u53EF\u7528");
      try {
        return await repo.createSalesAccount({ email: value2.email.trim().toLowerCase(), passwordHash: await passwords.hash(value2.password), product });
      } catch {
        return failure("UNAVAILABLE", "\u6CE8\u518C\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      }
    },
    async login(input) {
      const value2 = object2(input, ["email", "password"]);
      if (!value2 || typeof value2.email !== "string" || value2.email !== value2.email.trim() || !EMAIL_PATTERN2.test(value2.email.trim()) || value2.email.length > AUTH_LIMITS.emailMax || typeof value2.password !== "string" || value2.password.length < BOOTSTRAP_LOGIN_MIN || value2.password.length > AUTH_LIMITS.passwordMax)
        return failure("INVALID_INPUT", "\u767B\u5F55\u53C2\u6570\u65E0\u6548");
      const credential = await repo.credential(value2.email.trim().toLowerCase());
      if (!credential.ok)
        return credential;
      try {
        const verified = await passwords.verify(value2.password, credential.data?.passwordHash ?? "");
        if (!verified || !credential.data?.active || value2.password.length < AUTH_LIMITS.passwordMin && !credential.data.mustChangePassword)
          return unauthorized();
      } catch {
        return failure("UNAVAILABLE", "\u767B\u5F55\u6821\u9A8C\u6682\u4E0D\u53EF\u7528");
      }
      const token = tokens.create(), refreshToken = tokens.create(), expiresAt = date(ttlSeconds);
      const absoluteExpiresAt = date(DESKTOP_SESSION_LIMITS.absolute_seconds);
      const session = await repo.createDesktopSession({ tokenHash: tokens.hash(token), refreshHash: tokens.hash(refreshToken), userId: credential.data.userId, securityRevision: credential.data.securityRevision, expiresAt, idleExpiresAt: date(DESKTOP_SESSION_LIMITS.idle_seconds), absoluteExpiresAt });
      return !session.ok ? session : session.data ? loginResponse(token, refreshToken, expiresAt, session.data, absoluteExpiresAt) : unauthorized();
    },
    async refresh(input) {
      const value2 = object2(input, ["refreshToken"]);
      if (!value2 || !validToken(value2.refreshToken))
        return failure("INVALID_INPUT", "\u7EED\u671F\u53C2\u6570\u65E0\u6548");
      const token = tokens.create(), refreshToken = tokens.create(), expiresAt = date(ttlSeconds);
      const session = await repo.rotateDesktopSession(tokens.hash(value2.refreshToken), { tokenHash: tokens.hash(token), refreshHash: tokens.hash(refreshToken), expiresAt, idleExpiresAt: date(DESKTOP_SESSION_LIMITS.idle_seconds) });
      return !session.ok ? session : session.data ? loginResponse(token, refreshToken, session.data.expiresAt, session.data.identity, session.data.absoluteExpiresAt) : unauthorized();
    },
    async logout(input) {
      const value2 = object2(input, ["refreshToken"]);
      return value2 && validToken(value2.refreshToken) ? repo.revokeDesktopSession(tokens.hash(value2.refreshToken)) : failure("INVALID_INPUT", "\u9000\u51FA\u53C2\u6570\u65E0\u6548");
    },
    async changePassword(token, input) {
      const value2 = object2(input, ["currentPassword", "newPassword"]);
      if (!value2 || typeof value2.currentPassword !== "string" || !value2.currentPassword.length || value2.currentPassword.length > AUTH_LIMITS.passwordMax || !isNewAccountPassword(value2.newPassword) || value2.newPassword === value2.currentPassword)
        return failure("INVALID_INPUT", "\u65B0\u5BC6\u7801\u81F3\u5C116\u4F4D\uFF0C\u4EC5\u5141\u8BB8\u82F1\u6587\u5B57\u6BCD\u548C\u6570\u5B57\uFF0C\u4E14\u5FC5\u987B\u4E0E\u5F53\u524D\u5BC6\u7801\u4E0D\u540C");
      const identity = await me(token);
      if (!identity.ok)
        return identity;
      const credential = await repo.credential(identity.data.email);
      if (!credential.ok)
        return credential;
      if (!credential.data?.active)
        return unauthorized();
      try {
        if (!await passwords.verify(value2.currentPassword, credential.data.passwordHash))
          return unauthorized();
        return await repo.changePassword(tokens.hash(token), credential.data.passwordHash, credential.data.securityRevision, await passwords.hash(value2.newPassword), "api");
      } catch {
        return failure("UNAVAILABLE", "\u6539\u5BC6\u6682\u4E0D\u53EF\u7528");
      }
    }
  };
}

// server/transport/desktop-auth-http.ts
function createDesktopAuthHandler(service, gate, config) {
  return async (request2, response) => {
    const path4 = request2.url ?? "", token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request2.headers.authorization ?? "")?.[1] ?? "";
    if (request2.method === "GET" && path4 === DESKTOP_AUTH_ROUTES.me) {
      send(response, await service.me(token));
      return;
    }
    if (request2.method !== "POST") {
      send(response, failure("NOT_FOUND", "\u63A5\u53E3\u4E0D\u5B58\u5728"));
      return;
    }
    const input = await body(request2, config.request_body_bytes);
    if (!input.ok) {
      send(response, input);
      return;
    }
    if (path4 === DESKTOP_AUTH_ROUTES.register) {
      const email3 = input.data && typeof input.data === "object" && "email" in input.data && typeof input.data.email === "string" ? input.data.email.trim().toLowerCase() : "invalid";
      send(response, gate.allow(`register:${email3}`, request2.socket.remoteAddress ?? "unknown") ? await service.register(input.data) : failure("RATE_LIMITED", "\u8BF7\u6C42\u8FC7\u591A\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5"));
      return;
    }
    if (path4 === DESKTOP_AUTH_ROUTES.login) {
      const email3 = input.data && typeof input.data === "object" && "email" in input.data && typeof input.data.email === "string" ? input.data.email.trim().toLowerCase() : "invalid";
      send(response, gate.allow(email3, request2.socket.remoteAddress ?? "unknown") ? await service.login(input.data) : failure("RATE_LIMITED", "\u767B\u5F55\u5C1D\u8BD5\u8FC7\u591A\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5"));
      return;
    }
    if (path4 === DESKTOP_AUTH_ROUTES.refresh)
      send(response, await service.refresh(input.data));
    else if (path4 === DESKTOP_AUTH_ROUTES.logout)
      send(response, await service.logout(input.data));
    else if (path4 === DESKTOP_AUTH_ROUTES.password)
      send(response, await service.changePassword(token, input.data));
    else
      send(response, failure("NOT_FOUND", "\u63A5\u53E3\u4E0D\u5B58\u5728"));
  };
}

// server/adapters/offline-access.ts
var import_node_crypto16 = require("node:crypto");
var import_node_fs4 = require("node:fs");
var import_node_path5 = require("node:path");

// server/core/offline-access.ts
var OFFLINE_ACCESS_LIMITS = { validity_seconds: 72 * 60 * 60, clock_skew_seconds: 60, payload_bytes: 16384, public_key_bytes: 4096, signature_bytes: 256 };
var OFFLINE_ACCESS_AUDIENCE = "prospector-local";

// server/adapters/offline-access.ts
var OFFLINE_ACCESS_KEY_FILE = "offline-access-private.pem";
var SECOND_MS = 1e3;
var PRIVATE_KEY_BYTES = 4096;
var PRIVATE_FILE_MODE2 = 384;
function createOfflineAccessIssuer(privateKey, issuer) {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("\u79BB\u7EBF\u7B7E\u540D\u5BC6\u94A5\u7C7B\u578B\u65E0\u6548");
  const address = new URL(issuer);
  if (!["http:", "https:"].includes(address.protocol) || address.origin !== issuer || address.username || address.password)
    throw new Error("\u79BB\u7EBF\u7B7E\u53D1\u4E2D\u5FC3\u5730\u5740\u65E0\u6548");
  const publicKey = (0, import_node_crypto16.createPublicKey)(privateKey).export({ format: "pem", type: "spki" }).toString();
  return {
    issue(identity, now, absoluteExpiresAt = Infinity) {
      if (identity.mustChangePassword)
        return void 0;
      if (!Number.isFinite(now))
        throw new Error("\u79BB\u7EBF\u6388\u6743\u65F6\u95F4\u65E0\u6548");
      const expiresAt = Math.min(now + OFFLINE_ACCESS_LIMITS.validity_seconds * SECOND_MS, absoluteExpiresAt);
      if (!(expiresAt > now))
        throw new Error("\u79BB\u7EBF\u6388\u6743\u5DF2\u5230\u671F");
      const payload = { version: 1, audience: OFFLINE_ACCESS_AUDIENCE, issuer, issuedAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(), identity };
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized, "utf8") > OFFLINE_ACCESS_LIMITS.payload_bytes)
        throw new Error("\u79BB\u7EBF\u6388\u6743\u8EAB\u4EFD\u8D85\u51FA\u9650\u5236");
      return { payload: serialized, signature: (0, import_node_crypto16.sign)(null, Buffer.from(serialized, "utf8"), privateKey).toString("base64url"), publicKey };
    }
  };
}
function readPrivateKey(path4) {
  const info = (0, import_node_fs4.lstatSync)(path4);
  if (!info.isFile() || info.isSymbolicLink() || info.size > PRIVATE_KEY_BYTES)
    throw new Error("\u79BB\u7EBF\u7B7E\u540D\u5BC6\u94A5\u6587\u4EF6\u65E0\u6548");
  const key = (0, import_node_crypto16.createPrivateKey)((0, import_node_fs4.readFileSync)(path4));
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519")
    throw new Error("\u79BB\u7EBF\u7B7E\u540D\u5BC6\u94A5\u7C7B\u578B\u65E0\u6548");
  return key;
}
function loadOfflineAccessIssuer(runtimeDirectory, issuer) {
  const directory = (0, import_node_path5.resolve)(runtimeDirectory), info = (0, import_node_fs4.lstatSync)(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("\u79BB\u7EBF\u7B7E\u540D\u76EE\u5F55\u65E0\u6548");
  const path4 = (0, import_node_path5.join)(directory, OFFLINE_ACCESS_KEY_FILE);
  try {
    return createOfflineAccessIssuer(readPrivateKey(path4), issuer);
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("\u79BB\u7EBF\u7B7E\u540D\u5BC6\u94A5\u8BFB\u53D6\u5931\u8D25");
  }
  const temporary = (0, import_node_path5.join)(directory, `.offline-access-${(0, import_node_crypto16.randomUUID)()}.tmp`);
  const generated = (0, import_node_crypto16.generateKeyPairSync)("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
  (0, import_node_fs4.writeFileSync)(temporary, generated, { flag: "wx", mode: PRIVATE_FILE_MODE2 });
  try {
    try {
      (0, import_node_fs4.linkSync)(temporary, path4);
    } catch (error) {
      if (error.code !== "EEXIST")
        throw new Error("\u79BB\u7EBF\u7B7E\u540D\u5BC6\u94A5\u4FDD\u5B58\u5931\u8D25");
    }
  } finally {
    (0, import_node_fs4.unlinkSync)(temporary);
  }
  try {
    return createOfflineAccessIssuer(readPrivateKey(path4), issuer);
  } catch {
    throw new Error("\u79BB\u7EBF\u7B7E\u540D\u5BC6\u94A5\u8BFB\u53D6\u5931\u8D25");
  }
}

// server/services/tasks.ts
var UUID9 = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function record7(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function keys5(v, allowed) {
  return Object.keys(v).every((k) => allowed.includes(k));
}
function text6(v, max) {
  return typeof v === "string" && !!v.trim() && v.length <= max;
}
function positive4(v) {
  return Number.isSafeInteger(v) && Number(v) > 0;
}
function command2(v) {
  return record7(v) && typeof v.taskId === "string" && UUID9.test(v.taskId) && positive4(v.expectedVersion) && text6(v.idempotencyKey, TASK_LIMITS.key);
}
function createTaskService(repo, tokens) {
  function run2(token, action) {
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? action(tokens.hash(token)) : Promise.resolve(failure("UNAUTHORIZED", "\u4F1A\u8BDD\u65E0\u6548"));
  }
  return {
    create(token, v) {
      if (!record7(v) || !keys5(v, ["customerId", "title", "dueAt", "expectedCustomerVersion", "idempotencyKey", "opportunityId"]) || typeof v.customerId !== "string" || !UUID9.test(v.customerId) || v.opportunityId !== void 0 && (typeof v.opportunityId !== "string" || !UUID9.test(v.opportunityId)) || !text6(v.title, TASK_LIMITS.title) || !validTaskTime(v.dueAt) || !positive4(v.expectedCustomerVersion) || !text6(v.idempotencyKey, TASK_LIMITS.key))
        return Promise.resolve(failure("INVALID_INPUT", "\u4EFB\u52A1\u53C2\u6570\u65E0\u6548"));
      return run2(token, (h) => repo.create(h, v));
    },
    list(token, v) {
      if (!record7(v) || !keys5(v, ["customerId", "status", "limit", "offset"]) || v.customerId !== void 0 && (typeof v.customerId !== "string" || !UUID9.test(v.customerId)) || v.status !== void 0 && !["open", "completed"].includes(v.status) || !positive4(v.limit) || Number(v.limit) > TASK_LIMITS.pageMax || !Number.isSafeInteger(v.offset) || Number(v.offset) < 0)
        return Promise.resolve(failure("INVALID_INPUT", "\u4EFB\u52A1\u5217\u8868\u53C2\u6570\u65E0\u6548"));
      return run2(token, (h) => repo.list(h, v));
    },
    detail(token, id) {
      return UUID9.test(id) ? run2(token, (h) => repo.detail(h, id)) : Promise.resolve(failure("NOT_FOUND", "\u4EFB\u52A1\u4E0D\u5B58\u5728"));
    },
    reschedule(token, v) {
      if (!command2(v) || !keys5(v, ["taskId", "expectedVersion", "idempotencyKey", "dueAt"]) || !validTaskTime(v.dueAt))
        return Promise.resolve(failure("INVALID_INPUT", "\u5EF6\u671F\u53C2\u6570\u65E0\u6548"));
      return run2(token, (h) => repo.reschedule(h, v));
    },
    complete(token, v) {
      if (!command2(v) || !keys5(v, ["taskId", "expectedVersion", "idempotencyKey", "feedback"]) || !text6(v.feedback, TASK_LIMITS.feedback))
        return Promise.resolve(failure("INVALID_INPUT", "\u5B8C\u6210\u53CD\u9988\u65E0\u6548"));
      return run2(token, (h) => repo.complete(h, v));
    },
    processDue(limit = TASK_LIMITS.dueBatch) {
      return positive4(limit) && limit <= TASK_LIMITS.dueBatchMax ? repo.processDue(limit) : Promise.resolve(failure("INVALID_INPUT", "\u5230\u671F\u626B\u63CF\u6279\u6B21\u65E0\u6548"));
    }
  };
}

// server/transport/tasks-http.ts
function createTaskHandler(service) {
  return async (request2, response) => {
    const url = new URL(request2.url ?? "/", "http://localhost");
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request2.headers.authorization ?? "")?.[1] ?? "";
    if (request2.method === "GET" && url.pathname === TASK_ROUTES.tasks) {
      send(response, await service.list(token, { limit: Number(url.searchParams.get("limit") ?? TASK_LIMITS.page), offset: Number(url.searchParams.get("offset") ?? 0), ...url.searchParams.has("customerId") ? { customerId: url.searchParams.get("customerId") } : {}, ...url.searchParams.has("status") ? { status: url.searchParams.get("status") } : {} }));
      return;
    }
    const parts = url.pathname.slice(TASK_ROUTES.tasks.length + 1).split("/");
    if (request2.method === "GET" && url.pathname.startsWith(`${TASK_ROUTES.tasks}/`) && parts.length === 1) {
      send(response, await service.detail(token, parts[0]));
      return;
    }
    if (request2.method === "POST") {
      const input = await body(request2, LEAD_LIMITS.bodyBytes);
      if (!input.ok) {
        send(response, input);
        return;
      }
      if (url.pathname === TASK_ROUTES.tasks) {
        send(response, await service.create(token, input.data));
        return;
      }
      if (url.pathname.startsWith(`${TASK_ROUTES.tasks}/`) && parts.length === 2 && (parts[1] === TASK_ROUTES.rescheduleAction || parts[1] === TASK_ROUTES.completeAction)) {
        if (!input.data || typeof input.data !== "object" || Array.isArray(input.data) || "taskId" in input.data && input.data.taskId !== parts[0]) {
          send(response, failure("INVALID_INPUT", "\u8DEF\u5F84\u4E0E\u4EFB\u52A1\u7F16\u53F7\u4E0D\u4E00\u81F4"));
          return;
        }
        const command4 = { ...input.data, taskId: parts[0] };
        send(response, parts[1] === TASK_ROUTES.completeAction ? await service.complete(token, command4) : await service.reschedule(token, command4));
        return;
      }
    }
    send(response, failure("NOT_FOUND", "\u4EFB\u52A1\u63A5\u53E3\u4E0D\u5B58\u5728"));
  };
}

// server/adapters/task-dispatcher.ts
var MILLISECONDS_PER_SECOND12 = 1e3;
function startTaskDispatcher(service, log) {
  let stopped = false, timer, active;
  const tick = () => {
    if (stopped)
      return;
    active = (async () => {
      try {
        const result2 = await service.processDue();
        if (!result2.ok)
          log.write("WARN", "tasks.dispatch", "\u8DDF\u8FDB\u63D0\u9192\u626B\u63CF\u6682\u4E0D\u53EF\u7528");
      } catch (error) {
        log.write("ERROR", "tasks.dispatch", `\u8DDF\u8FDB\u63D0\u9192\u626B\u63CF\u5931\u8D25 ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      } finally {
        if (!stopped) {
          timer = setTimeout(tick, TASK_LIMITS.poll_seconds * MILLISECONDS_PER_SECOND12);
          timer.unref();
        }
      }
    })();
  };
  tick();
  return { async stop() {
    stopped = true;
    if (timer)
      clearTimeout(timer);
    await active;
  } };
}

// server/adapters/postgres/opportunity-repository.ts
var import_node_crypto17 = require("node:crypto");

// server/adapters/postgres/opportunity-schema.ts
var OPPORTUNITY_VERSION = "018-opportunities-public";
var OPPORTUNITY_LOCK = 19041018;
var STAGES = OPPORTUNITY_STAGES.map((s) => `'${s}'`).join(",");
var MONEY = `CHECK((amount IS NULL AND currency IS NULL) OR (amount IS NOT NULL AND currency IS NOT NULL AND amount>=0 AND amount<power(10::numeric,${OPPORTUNITY_LIMITS.amountWholeDigits}) AND scale(amount)<=${OPPORTUNITY_LIMITS.amountFractionDigits} AND currency ~ '^[A-Z]{3}$'))`;
var OPPORTUNITY_SQL = `
CREATE TABLE crm_opportunities (
 opportunity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
 title text NOT NULL CHECK(btrim(title)<>'' AND length(title)<=${OPPORTUNITY_LIMITS.title}),
 description text NOT NULL DEFAULT '' CHECK(length(description)<=${OPPORTUNITY_LIMITS.description}),
 pol text CHECK(length(pol)<=${OPPORTUNITY_LIMITS.route}),pod text CHECK(length(pod)<=${OPPORTUNITY_LIMITS.route}),container_type text CHECK(length(container_type)<=${OPPORTUNITY_LIMITS.route}),
 source text NOT NULL DEFAULT '' CHECK(length(source)<=${OPPORTUNITY_LIMITS.source}),
 stage text NOT NULL DEFAULT 'inquiry' CHECK(stage IN (${STAGES})),amount numeric,currency text,${MONEY},
 lost_reason text CHECK(btrim(lost_reason)<>'' AND length(lost_reason)<=${OPPORTUNITY_LIMITS.reason}),evidence text CHECK(btrim(evidence)<>'' AND length(evidence)<=${OPPORTUNITY_LIMITS.evidence}),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid NOT NULL REFERENCES public.identity_users(user_id),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),closed_at timestamptz,closed_by uuid REFERENCES public.identity_users(user_id),
 UNIQUE(opportunity_id,customer_id),
 CHECK((stage IN ('closed_won','closed_lost') AND closed_at IS NOT NULL AND closed_by IS NOT NULL) OR (stage NOT IN ('closed_won','closed_lost') AND closed_at IS NULL AND closed_by IS NULL)),
 CHECK((stage='closed_won' AND evidence IS NOT NULL AND amount IS NOT NULL AND lost_reason IS NULL) OR (stage='closed_lost' AND lost_reason IS NOT NULL AND evidence IS NULL) OR (stage NOT IN ('closed_won','closed_lost') AND evidence IS NULL AND lost_reason IS NULL))
);
CREATE INDEX idx_crm_opportunities_customer ON crm_opportunities(customer_id,created_at,opportunity_id);
CREATE TABLE crm_opportunity_stage_history (
 history_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),opportunity_id uuid NOT NULL REFERENCES crm_opportunities(opportunity_id),
 from_stage text CHECK(from_stage IN (${STAGES})),to_stage text NOT NULL CHECK(to_stage IN (${STAGES})),
 actor_id uuid NOT NULL REFERENCES public.identity_users(user_id),occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 amount numeric,currency text,${MONEY},lost_reason text,evidence text,
 CHECK(from_stage IS DISTINCT FROM to_stage),
 CHECK((to_stage='closed_won' AND evidence IS NOT NULL AND btrim(evidence)<>'' AND length(evidence)<=${OPPORTUNITY_LIMITS.evidence} AND amount IS NOT NULL AND lost_reason IS NULL) OR (to_stage='closed_lost' AND lost_reason IS NOT NULL AND btrim(lost_reason)<>'' AND length(lost_reason)<=${OPPORTUNITY_LIMITS.reason} AND evidence IS NULL) OR (to_stage NOT IN ('closed_won','closed_lost') AND evidence IS NULL AND lost_reason IS NULL))
);
CREATE INDEX idx_crm_opportunity_history ON crm_opportunity_stage_history(opportunity_id,occurred_at,history_id);
CREATE FUNCTION crm_opportunity_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Opportunity stage history is append only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER crm_opportunity_history_append_only BEFORE UPDATE OR DELETE ON crm_opportunity_stage_history FOR EACH ROW EXECUTE FUNCTION crm_opportunity_history_append_only();
CREATE FUNCTION crm_opportunities_customer_owner_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
  UPDATE crm_opportunities SET version=version+1,updated_at=clock_timestamp() WHERE customer_id=NEW.customer_id AND stage NOT IN ('closed_won','closed_lost');
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER crm_opportunities_customer_owner_changed AFTER UPDATE OF owner_user_id ON crm_customers FOR EACH ROW EXECUTE FUNCTION crm_opportunities_customer_owner_changed();
ALTER TABLE crm_shared_activities ADD COLUMN opportunity_id uuid;
ALTER TABLE crm_shared_activities ADD CONSTRAINT crm_activity_opportunity_customer_fk FOREIGN KEY(opportunity_id,customer_id) REFERENCES crm_opportunities(opportunity_id,customer_id);
CREATE INDEX idx_crm_activity_opportunity ON crm_shared_activities(opportunity_id) WHERE opportunity_id IS NOT NULL;
ALTER TABLE crm_followup_tasks ADD COLUMN opportunity_id uuid;
ALTER TABLE crm_followup_tasks ADD CONSTRAINT crm_task_opportunity_customer_fk FOREIGN KEY(opportunity_id,customer_id) REFERENCES crm_opportunities(opportunity_id,customer_id);
CREATE INDEX idx_crm_task_opportunity ON crm_followup_tasks(opportunity_id) WHERE opportunity_id IS NOT NULL;
`;

// server/adapters/postgres/opportunity-repository.ts
function administrator3(a) {
  return a.roles.includes("admin") && ["shared", "summary"].includes(a.scope) && a.capabilities.includes("leads.read.all");
}
function operations2(a) {
  return a.roles.includes("operations") && ["shared", "summary"].includes(a.scope) && a.capabilities.includes("followups.read");
}
function canSee2(a, c) {
  return administrator3(a) || operations2(a) && c.origin === "operations" || c.owner_user_id === a.userId && a.capabilities.includes("leads.develop");
}
function canManage2(a, c) {
  return a.capabilities.includes("leads.develop") && (administrator3(a) || operations2(a) && c.origin === "operations" && c.owner_user_id === null || c.owner_user_id === a.userId && canSee2(a, c));
}
var MONEY_TYPE = `numeric(${OPPORTUNITY_LIMITS.amountWholeDigits + OPPORTUNITY_LIMITS.amountFractionDigits},${OPPORTUNITY_LIMITS.amountFractionDigits})`;
var COLUMNS2 = `o.opportunity_id AS "opportunityId",o.customer_id AS "customerId",o.title,o.description,o.pol,o.pod,o.container_type AS "containerType",o.source,o.stage,o.amount::${MONEY_TYPE}::text AS amount,o.currency,o.lost_reason AS "lostReason",o.evidence,o.version,o.created_by AS "createdBy",o.created_at AS "createdAt",o.updated_at AS "updatedAt",o.closed_at AS "closedAt",o.closed_by AS "closedBy",COALESCE(c.owner_user_id,c.created_by) AS "ownerUserId",u.display_name AS "ownerName"`;
function dates2(row2) {
  return Object.fromEntries(Object.entries(row2).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
}
function sameAmount(a, b) {
  if (b === void 0)
    return true;
  if (a === null)
    return false;
  const normalize = (v) => {
    const [whole, fraction = ""] = v.split(".");
    return `${whole}.${fraction.padEnd(OPPORTUNITY_LIMITS.amountFractionDigits, "0")}`;
  };
  return normalize(a) === normalize(b);
}
var PostgresOpportunityRepository = class {
  constructor(pool, log) {
    this.pool = pool;
    this.log = log;
    assertCenterDatabasePool(pool);
  }
  async tx(fn) {
    let db;
    try {
      db = await this.pool.connect();
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK]);
      await db.query("SELECT pg_advisory_xact_lock($1)", [OPPORTUNITY_LOCK]);
      const result2 = await fn(db);
      await db.query(result2.ok ? "COMMIT" : "ROLLBACK");
      return result2;
    } catch (error) {
      if (db)
        try {
          await db.query("ROLLBACK");
        } catch (rollbackError) {
          this.log.write("ERROR", "opportunities.rollback", `\u5546\u673A\u56DE\u6EDA\u5931\u8D25 ${rollbackError instanceof Error ? rollbackError.stack ?? rollbackError.message : "UNKNOWN"}`);
        }
      this.log.write("ERROR", "opportunities.pg", `\u5546\u673A\u6570\u636E\u5E93\u64CD\u4F5C\u5931\u8D25 ${error instanceof Error ? error.stack ?? error.message : "UNKNOWN"}`);
      return failure("DATABASE_ERROR", "\u5546\u673A\u670D\u52A1\u6682\u4E0D\u53EF\u7528");
    } finally {
      db?.release();
    }
  }
  authorized(hash, fn) {
    return this.tx(async (db) => {
      const a = await authorizeLeadActor(db, hash);
      return a ? fn(db, a) : failure("UNAUTHORIZED", "CRM\u4F1A\u8BDD\u6216\u4EA7\u54C1\u51C6\u5165\u5DF2\u5931\u6548");
    });
  }
  async customer(db, id) {
    const r = await db.query("SELECT customer_id,created_by,owner_user_id,origin,state,version FROM crm_customers WHERE customer_id=$1 FOR SHARE", [id]);
    return r.rows[0];
  }
  async history(db, id) {
    const r = await db.query(`SELECT h.history_id AS "historyId",h.from_stage AS "fromStage",h.to_stage AS "toStage",h.actor_id AS "actorId",u.display_name AS "actorName",h.occurred_at AS "occurredAt",h.amount::${MONEY_TYPE}::text AS amount,h.currency,h.lost_reason AS "lostReason",h.evidence FROM crm_opportunity_stage_history h LEFT JOIN public.identity_users u ON u.user_id=h.actor_id WHERE h.opportunity_id=$1 ORDER BY h.occurred_at,h.history_id`, [id]);
    return r.rows.map((x) => dates2(x));
  }
  async one(db, id, a, lock = false) {
    const r = await db.query(`SELECT ${COLUMNS2} FROM crm_opportunities o JOIN crm_customers c USING(customer_id) JOIN public.identity_users u ON u.user_id=COALESCE(c.owner_user_id,c.created_by) WHERE o.opportunity_id=$1 ${lock ? "FOR UPDATE OF o" : ""}`, [id]);
    if (!r.rows.length)
      return failure("NOT_FOUND", "\u5546\u673A\u4E0D\u5B58\u5728");
    const customer2 = await this.customer(db, r.rows[0].customerId);
    if (!customer2 || !canSee2(a, customer2))
      return failure("NOT_FOUND", "\u5546\u673A\u4E0D\u5B58\u5728");
    return success({ ...dates2(r.rows[0]), canManage: canManage2(a, customer2), history: await this.history(db, id) });
  }
  async cached(db, a, operation, input, fn) {
    const digest = (0, import_node_crypto17.createHash)("sha256").update(JSON.stringify(input)).digest("hex"), old = await db.query("SELECT digest,response FROM crm_lead_idempotency WHERE actor_id=$1 AND operation=$2 AND key=$3", [a.userId, operation, input.idempotencyKey]);
    if (old.rows.length) {
      if (old.rows[0].digest !== digest)
        return failure("CONFLICT", "\u5E42\u7B49\u952E\u5DF2\u7528\u4E8E\u4E0D\u540C\u8BF7\u6C42");
      const current = await this.one(db, old.rows[0].response.opportunityId, a);
      if (!current.ok)
        return current;
      if (!current.data.canManage)
        return failure("FORBIDDEN", "\u53EA\u80FD\u5904\u7406\u81EA\u8EAB\u5546\u673A");
      return current;
    }
    const result2 = await fn();
    if (result2.ok)
      await db.query("INSERT INTO crm_lead_idempotency(actor_id,operation,key,digest,response) VALUES($1,$2,$3,$4,$5)", [a.userId, operation, input.idempotencyKey, digest, JSON.stringify({ opportunityId: result2.data.opportunityId })]);
    return result2;
  }
  async record(db, a, o, from) {
    await db.query("INSERT INTO crm_opportunity_stage_history(opportunity_id,from_stage,to_stage,actor_id,amount,currency,lost_reason,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [o.opportunityId, from, o.stage, a.userId, o.amount, o.currency, o.lostReason, o.evidence]);
    const c = await this.customer(db, o.customerId);
    await db.query("INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload) VALUES($1,$2,$3,$4,$5,$6)", [from === null ? OPPORTUNITY_EVENTS.created : OPPORTUNITY_EVENTS.stageChanged, a.userId, "crm", c.version, o.customerId, JSON.stringify({ customerId: o.customerId, version: c.version, opportunityId: o.opportunityId, opportunityVersion: o.version })]);
  }
  migrate() {
    return this.tx(async (db) => {
      const hash = (0, import_node_crypto17.createHash)("sha256").update(OPPORTUNITY_SQL).digest("hex"), old = await db.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [OPPORTUNITY_VERSION]);
      if (old.rows.length && old.rows[0].checksum !== hash)
        return failure("CONFLICT", "\u5546\u673A\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!old.rows.length) {
        await db.query(OPPORTUNITY_SQL);
        await db.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [OPPORTUNITY_VERSION, hash]);
        this.log.write("INFO", "opportunities.migrate", `\u8FC1\u79FB\u5B8C\u6210 version=${OPPORTUNITY_VERSION}`);
      }
      return success(void 0);
    });
  }
  create(hash, input) {
    return this.authorized(hash, async (db, a) => {
      const c = await this.customer(db, input.customerId);
      if (!c || !canSee2(a, c))
        return failure("NOT_FOUND", "\u5BA2\u6237\u4E0D\u5B58\u5728");
      if (!canManage2(a, c))
        return failure("FORBIDDEN", "\u53EA\u80FD\u5904\u7406\u81EA\u8EAB\u5546\u673A");
      return this.cached(db, a, `opportunity:create:${input.customerId}`, input, async () => {
        if (c.version !== input.expectedCustomerVersion)
          return failure("CONFLICT", "\u5BA2\u6237\u7248\u672C\u5DF2\u53D8\u5316");
        const r = await db.query("INSERT INTO crm_opportunities(customer_id,title,description,pol,pod,container_type,source,amount,currency,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING opportunity_id", [input.customerId, input.title.trim(), input.description?.trim() ?? "", input.pol?.trim() || null, input.pod?.trim() || null, input.containerType?.trim() || null, input.source?.trim() ?? "", input.amount ?? null, input.currency ?? null, a.userId]);
        const created = await this.one(db, r.rows[0].opportunity_id, a);
        if (!created.ok)
          return created;
        await this.record(db, a, created.data, null);
        return this.one(db, created.data.opportunityId, a);
      });
    });
  }
  list(hash, input) {
    return this.authorized(hash, async (db, a) => {
      const c = await this.customer(db, input.customerId);
      if (!c || !canSee2(a, c))
        return failure("NOT_FOUND", "\u5BA2\u6237\u4E0D\u5B58\u5728");
      const count = await db.query("SELECT count(*)::int AS n FROM crm_opportunities WHERE customer_id=$1", [input.customerId]), rows = await db.query(`SELECT ${COLUMNS2} FROM crm_opportunities o JOIN crm_customers c USING(customer_id) JOIN public.identity_users u ON u.user_id=COALESCE(c.owner_user_id,c.created_by) WHERE o.customer_id=$1 ORDER BY o.created_at DESC,o.opportunity_id LIMIT $2 OFFSET $3`, [input.customerId, input.limit, input.offset]);
      const items = [];
      for (const row2 of rows.rows)
        items.push({ ...dates2(row2), canManage: canManage2(a, c), history: await this.history(db, row2.opportunityId) });
      return success({ items, total: count.rows[0].n });
    });
  }
  detail(hash, id) {
    return this.authorized(hash, (db, a) => this.one(db, id, a));
  }
  updateStage(hash, input) {
    return this.authorized(hash, async (db, a) => {
      const existing = await this.one(db, input.opportunityId, a, true);
      if (!existing.ok)
        return existing;
      if (!existing.data.canManage)
        return failure("FORBIDDEN", "\u53EA\u80FD\u5904\u7406\u81EA\u8EAB\u5546\u673A");
      return this.cached(db, a, `opportunity:stage:${input.opportunityId}`, input, async () => {
        const o = existing.data;
        if (o.version !== input.expectedVersion)
          return failure("CONFLICT", "\u5546\u673A\u7248\u672C\u5DF2\u53D8\u5316");
        if (o.stage === input.stage) {
          if (!sameAmount(o.amount, input.amount) || input.currency !== void 0 && o.currency !== input.currency || input.evidence !== void 0 && o.evidence !== input.evidence.trim() || input.lostReason !== void 0 && o.lostReason !== input.lostReason.trim())
            return failure("INVALID_INPUT", "\u540C\u9636\u6BB5\u4E0D\u80FD\u4FEE\u6539\u6210\u4EA4\u4FE1\u606F");
          return success(o);
        }
        if (["closed_won", "closed_lost"].includes(o.stage) || OPPORTUNITY_STAGES.indexOf(input.stage) < OPPORTUNITY_STAGES.indexOf(o.stage))
          return failure("CONFLICT", "\u5546\u673A\u9636\u6BB5\u4E0D\u80FD\u56DE\u9000\u6216\u91CD\u5F00");
        const amount2 = input.amount ?? o.amount, currency = input.currency ?? o.currency, evidence = input.stage === "closed_won" ? input.evidence?.trim() ?? null : null, lostReason = input.stage === "closed_lost" ? input.lostReason?.trim() ?? null : null;
        if (input.stage === "closed_won" && (!amount2 || !currency || !evidence) || input.stage === "closed_lost" && !lostReason)
          return failure("INVALID_INPUT", "\u6210\u4EA4\u9700\u91D1\u989D\u3001\u5E01\u79CD\u548C\u8BC1\u636E\uFF1B\u4E22\u5355\u9700\u539F\u56E0");
        await db.query(`UPDATE crm_opportunities SET stage=$2,amount=$3,currency=$4,evidence=$5,lost_reason=$6,version=version+1,updated_at=clock_timestamp(),closed_at=CASE WHEN $2 IN ('closed_won','closed_lost') THEN clock_timestamp() ELSE NULL END,closed_by=CASE WHEN $2 IN ('closed_won','closed_lost') THEN $7::uuid ELSE NULL END WHERE opportunity_id=$1 AND version=$8`, [input.opportunityId, input.stage, amount2, currency, evidence, lostReason, a.userId, input.expectedVersion]);
        const changed = await this.one(db, input.opportunityId, a);
        if (!changed.ok)
          return changed;
        await this.record(db, a, changed.data, o.stage);
        return this.one(db, input.opportunityId, a);
      });
    });
  }
};

// server/services/opportunities.ts
var UUID10 = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
var AMOUNT = new RegExp(`^(0|[1-9][0-9]{0,${OPPORTUNITY_LIMITS.amountWholeDigits - 1}})(\\.[0-9]{1,${OPPORTUNITY_LIMITS.amountFractionDigits}})?$`);
function record8(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function keys6(v, allowed) {
  return Object.keys(v).every((k) => allowed.includes(k));
}
function text7(v, max, required = false) {
  return typeof v === "string" && v.length <= max && (!required || !!v.trim());
}
function positive5(v) {
  return Number.isSafeInteger(v) && Number(v) > 0;
}
function amount(v) {
  return v.amount === void 0 && v.currency === void 0 || typeof v.amount === "string" && AMOUNT.test(v.amount) && typeof v.currency === "string" && /^[A-Z]{3}$/.test(v.currency);
}
function createOpportunityService(repo, tokens) {
  function run2(token, action) {
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? action(tokens.hash(token)) : Promise.resolve(failure("UNAUTHORIZED", "\u4F1A\u8BDD\u65E0\u6548"));
  }
  return {
    create(token, v) {
      if (!record8(v) || !keys6(v, ["customerId", "expectedCustomerVersion", "idempotencyKey", "title", "description", "pol", "pod", "containerType", "source", "amount", "currency"]) || typeof v.customerId !== "string" || !UUID10.test(v.customerId) || !positive5(v.expectedCustomerVersion) || !text7(v.idempotencyKey, OPPORTUNITY_LIMITS.key, true) || !text7(v.title, OPPORTUNITY_LIMITS.title, true) || !amount(v) || v.description !== void 0 && !text7(v.description, OPPORTUNITY_LIMITS.description) || ["pol", "pod", "containerType"].some((k) => v[k] !== void 0 && !text7(v[k], OPPORTUNITY_LIMITS.route)) || v.source !== void 0 && !text7(v.source, OPPORTUNITY_LIMITS.source))
        return Promise.resolve(failure("INVALID_INPUT", "\u5546\u673A\u53C2\u6570\u65E0\u6548"));
      return run2(token, (h) => repo.create(h, v));
    },
    list(token, v) {
      if (!record8(v) || !keys6(v, ["customerId", "limit", "offset"]) || typeof v.customerId !== "string" || !UUID10.test(v.customerId) || !positive5(v.limit) || v.limit > OPPORTUNITY_LIMITS.pageMax || !Number.isSafeInteger(v.offset) || v.offset < 0)
        return Promise.resolve(failure("INVALID_INPUT", "\u5546\u673A\u5217\u8868\u53C2\u6570\u65E0\u6548"));
      return run2(token, (h) => repo.list(h, v));
    },
    detail(token, id) {
      return typeof id === "string" && UUID10.test(id) ? run2(token, (h) => repo.detail(h, id)) : Promise.resolve(failure("NOT_FOUND", "\u5546\u673A\u4E0D\u5B58\u5728"));
    },
    updateStage(token, v) {
      if (!record8(v) || !keys6(v, ["opportunityId", "expectedVersion", "idempotencyKey", "stage", "amount", "currency", "evidence", "lostReason"]) || typeof v.opportunityId !== "string" || !UUID10.test(v.opportunityId) || !positive5(v.expectedVersion) || !text7(v.idempotencyKey, OPPORTUNITY_LIMITS.key, true) || !OPPORTUNITY_STAGES.includes(v.stage) || !amount(v) || v.evidence !== void 0 && !text7(v.evidence, OPPORTUNITY_LIMITS.evidence, true) || v.lostReason !== void 0 && !text7(v.lostReason, OPPORTUNITY_LIMITS.reason, true) || v.stage === "closed_won" && !text7(v.evidence, OPPORTUNITY_LIMITS.evidence, true) || v.stage === "closed_lost" && !text7(v.lostReason, OPPORTUNITY_LIMITS.reason, true) || v.evidence !== void 0 && v.stage !== "closed_won" || v.lostReason !== void 0 && v.stage !== "closed_lost")
        return Promise.resolve(failure("INVALID_INPUT", "\u5546\u673A\u9636\u6BB5\u53C2\u6570\u65E0\u6548"));
      return run2(token, (h) => repo.updateStage(h, v));
    }
  };
}

// server/transport/opportunities-http.ts
function createOpportunityHandler(service) {
  return async (request2, response) => {
    const url = new URL(request2.url ?? "/", "http://localhost"), token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request2.headers.authorization ?? "")?.[1] ?? "";
    if (request2.method === "GET" && url.pathname === OPPORTUNITY_ROUTES.opportunities) {
      send(response, await service.list(token, { customerId: url.searchParams.get("customerId") ?? "", limit: Number(url.searchParams.get("limit") ?? OPPORTUNITY_LIMITS.page), offset: Number(url.searchParams.get("offset") ?? 0) }));
      return;
    }
    const prefix = `${OPPORTUNITY_ROUTES.opportunities}/`, parts = url.pathname.slice(prefix.length).split("/");
    if (request2.method === "GET" && url.pathname.startsWith(prefix) && parts.length === 1) {
      send(response, await service.detail(token, parts[0]));
      return;
    }
    if (request2.method === "POST" && (url.pathname === OPPORTUNITY_ROUTES.opportunities || url.pathname.startsWith(prefix) && parts.length === 2 && parts[1] === OPPORTUNITY_ROUTES.stageAction)) {
      const input = await body(request2, LEAD_LIMITS.bodyBytes);
      if (!input.ok) {
        send(response, input);
        return;
      }
      if (url.pathname === OPPORTUNITY_ROUTES.opportunities) {
        send(response, await service.create(token, input.data));
        return;
      }
      if (!input.data || typeof input.data !== "object" || Array.isArray(input.data) || "opportunityId" in input.data && input.data.opportunityId !== parts[0]) {
        send(response, failure("INVALID_INPUT", "\u8DEF\u5F84\u4E0E\u5546\u673A\u7F16\u53F7\u4E0D\u4E00\u81F4"));
        return;
      }
      send(response, await service.updateStage(token, { ...input.data, opportunityId: parts[0] }));
      return;
    }
    send(response, failure("NOT_FOUND", "\u5546\u673A\u63A5\u53E3\u4E0D\u5B58\u5728"));
  };
}

// server/services/management-dashboard.ts
function createManagementDashboardService(repo, tokens) {
  const dashboard = (token) => repo.dashboard(tokens.hash(token));
  const operations3 = (token) => repo.operations(tokens.hash(token));
  return { dashboard, operations: operations3 };
}

// server/services/admin-data-browser.ts
function createAdminDataBrowserService(repo, tokens) {
  const tables = (token) => repo.dataTables(tokens.hash(token));
  const page = (token, query) => repo.dataPage(tokens.hash(token), query);
  return { tables, page };
}

// server/adapters/postgres/contact-change-repository.ts
var import_node_crypto18 = require("node:crypto");

// server/adapters/postgres/contact-change-schema.ts
var CONTACT_CHANGE_VERSION = "008-contact-change-import-capture-public";
var CONTACT_CHANGE_LOCK = 19041007;
var CONTACT_CHANGE_SQL = `
CREATE SEQUENCE IF NOT EXISTS crm_contact_change_seq AS bigint;
CREATE TABLE IF NOT EXISTS crm_contact_changes (
 change_seq bigint PRIMARY KEY DEFAULT nextval('crm_contact_change_seq'), event_id uuid NOT NULL REFERENCES public.identity_outbox(event_id),
 recipient_user_id uuid NOT NULL REFERENCES public.identity_users(user_id), contact_id integer NOT NULL, customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),
 event_type text NOT NULL, version integer NOT NULL CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(event_id,recipient_user_id,contact_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_contact_changes_user_seq ON crm_contact_changes(recipient_user_id,change_seq);
CREATE OR REPLACE FUNCTION crm_contact_change_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.product_id='crm' AND NEW.customer_id IS NOT NULL AND (
   NEW.event_type = ANY(ARRAY[
     'crm.contact.updated','crm.contact.followup','crm.contact.deleted',
     'crm.contact.assignment.requested','crm.contact.assignment.accepted',
     'crm.contact.assignment.rejected','crm.contact.assignment.cancelled',
     'crm.contact.share.accepted','crm.contact.share.revoked','crm.contact.share.updated'
   ]) OR NEW.event_type = ANY(ARRAY['crm.customer.created','crm.customer.updated'])
 ) THEN
  INSERT INTO crm_contact_changes(event_id,recipient_user_id,contact_id,customer_id,event_type,version)
  SELECT NEW.event_id,u.user_id,ct.id,NEW.customer_id,NEW.event_type,COALESCE(NEW.revision,1)
  FROM crm_customer_contacts cc JOIN contacts ct ON ct.id=cc.contact_id CROSS JOIN public.identity_users u
  LEFT JOIN public.identity_product_access pa ON pa.user_id=u.user_id AND pa.product_id='crm' AND pa.active
  LEFT JOIN public.identity_product_grants g ON g.user_id=u.user_id AND g.product_id='crm' AND g.active AND g.role='admin'
  WHERE cc.customer_id=NEW.customer_id
    AND ((NEW.event_type = ANY(ARRAY['crm.customer.created','crm.customer.updated'])) OR ((NEW.payload->>'contactId') ~ '^[0-9]+$' AND ct.id=(NEW.payload->>'contactId')::integer))
    AND u.active AND NOT u.must_change_password AND pa.user_id IS NOT NULL
    AND (u.user_id=NEW.user_id OR u.user_id=ANY(COALESCE(NEW.recipient_user_ids,'{}'::uuid[])) OR (g.user_id IS NOT NULL AND pa.scope IN ('shared','summary') AND (u.identity_admin OR pa.capabilities IS NULL OR pa.capabilities ? 'leads.read.all')))
  ON CONFLICT(event_id,recipient_user_id,contact_id) DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS crm_contact_change_capture ON public.identity_outbox;
CREATE TRIGGER crm_contact_change_capture AFTER INSERT ON public.identity_outbox FOR EACH ROW EXECUTE FUNCTION crm_contact_change_capture();
`;

// server/adapters/postgres/contact-change-repository.ts
var TOMBSTONE_EVENTS = /* @__PURE__ */ new Set(["crm.contact.deleted", "crm.contact.share.revoked"]);
var PostgresContactChangeRepository = class {
  constructor(pool, log) {
    this.pool = pool;
    this.log = log;
    assertCenterDatabasePool(pool);
  }
  async tx(fn) {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock($1)", [CONTACT_CHANGE_LOCK]);
      const result2 = await fn(db);
      await db.query(result2.ok ? "COMMIT" : "ROLLBACK");
      return result2;
    } catch {
      try {
        await db.query("ROLLBACK");
      } catch {
        this.log.write("ERROR", "contact-change.rollback", "\u8054\u7CFB\u4EBA\u53D8\u5316\u56DE\u6EDA\u5931\u8D25");
      }
      this.log.write("ERROR", "contact-change.pg", "\u8054\u7CFB\u4EBA\u53D8\u5316\u6570\u636E\u5E93\u64CD\u4F5C\u5931\u8D25");
      return failure("DATABASE_ERROR", "\u8054\u7CFB\u4EBA\u53D8\u5316\u670D\u52A1\u6682\u4E0D\u53EF\u7528");
    } finally {
      db.release();
    }
  }
  async migrate() {
    return this.tx(async (db) => {
      const checksum = (0, import_node_crypto18.createHash)("sha256").update(CONTACT_CHANGE_SQL).digest("hex");
      const old = await db.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [CONTACT_CHANGE_VERSION]);
      if (old.rows.length && old.rows[0].checksum !== checksum)
        return failure("CONFLICT", "\u8054\u7CFB\u4EBA\u53D8\u5316\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!old.rows.length) {
        await db.query(CONTACT_CHANGE_SQL);
        await db.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [CONTACT_CHANGE_VERSION, checksum]);
      }
      return success(void 0);
    });
  }
  async feed(hash, q) {
    return this.tx(async (db) => {
      const actor = await authorizeLeadActor(db, hash);
      if (!actor)
        return failure("UNAUTHORIZED", "CRM\u4F1A\u8BDD\u6216\u4EA7\u54C1\u51C6\u5165\u5DF2\u5931\u6548");
      const head = await db.query("SELECT COALESCE(max(change_seq),0)::text AS high FROM crm_contact_changes");
      const high = head.rows[0].high;
      if (BigInt(q.after) > BigInt(high))
        return success({ items: [], nextCursor: high, hasMore: false, resyncRequired: true, headCursor: high });
      const rows = await db.query('SELECT change_seq::text AS cursor,event_id::text AS "eventId",contact_id AS "contactId",customer_id AS "customerId",event_type AS "eventType",version FROM crm_contact_changes WHERE recipient_user_id=$1 AND change_seq>$2 ORDER BY change_seq LIMIT $3', [actor.userId, q.after, q.limit]);
      const items = [];
      let cursor = q.after;
      for (const row2 of rows.rows) {
        cursor = row2.cursor;
        const current = await contact(db, { contactId: row2.contactId, customerId: row2.customerId });
        if (current && read(actor, current)) {
          const detail = await contactDetailIn(db, actor, { contactId: row2.contactId, customerId: row2.customerId });
          if (detail.ok) {
            items.push({ cursor, eventId: row2.eventId, eventType: row2.eventType, contactId: row2.contactId, customerId: row2.customerId, version: row2.version, kind: "upsert", contact: detail.data.contact });
          }
        } else if (TOMBSTONE_EVENTS.has(row2.eventType) || !current || current && !read(actor, current)) {
          items.push({ cursor, eventId: row2.eventId, eventType: row2.eventType, contactId: row2.contactId, customerId: row2.customerId, version: row2.version, kind: "tombstone" });
        }
        if (items.length >= q.limit)
          break;
      }
      if (!rows.rows.length)
        cursor = high;
      return success({ items, nextCursor: cursor, hasMore: BigInt(cursor) < BigInt(high), headCursor: high });
    });
  }
};

// server/core/contact-change-feed.ts
var CONTACT_CHANGE_ROUTE = "/api/crm/contact-changes";
var CONTACT_CHANGE_LIMITS = { page: 50, pageMax: 100, cursorDigits: 19 };
function contactChangeQuery(value2) {
  if (!value2 || typeof value2 !== "object" || Array.isArray(value2))
    return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u53D8\u5316\u53C2\u6570\u65E0\u6548");
  const input = value2;
  if (Object.keys(input).some((k) => !["after", "limit"].includes(k)))
    return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u53D8\u5316\u53C2\u6570\u65E0\u6548");
  const after = input.after ?? "0", limitValue = input.limit ?? CONTACT_CHANGE_LIMITS.page;
  const limit = typeof limitValue === "number" ? limitValue : Number.NaN;
  const cursor = new RegExp(`^(0|[1-9][0-9]{0,${CONTACT_CHANGE_LIMITS.cursorDigits - 1}})$`);
  if (typeof after !== "string" || !cursor.test(after) || BigInt(after) > 9223372036854775807n || !Number.isSafeInteger(limit) || limit < 1 || limit > CONTACT_CHANGE_LIMITS.pageMax)
    return failure("INVALID_INPUT", "\u8054\u7CFB\u4EBA\u53D8\u5316\u6E38\u6807\u65E0\u6548");
  return success({ after, limit });
}

// server/services/contact-change-feed.ts
function createContactChangeService(repo, tokens) {
  return { feed(token, input) {
    const query = contactChangeQuery(input);
    if (!query.ok)
      return Promise.resolve(query);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      return Promise.resolve(failure("UNAUTHORIZED", "\u4F1A\u8BDD\u65E0\u6548"));
    return repo.feed(tokens.hash(token), query.data);
  } };
}

// server/transport/contact-change-http.ts
function createContactChangeHandler(service) {
  return async (request2, response) => {
    const path4 = new URL(request2.url ?? "/", "http://localhost").pathname;
    if (request2.method !== "GET" || path4 !== CONTACT_CHANGE_ROUTE) {
      send(response, failure("NOT_FOUND", "\u8054\u7CFB\u4EBA\u53D8\u5316\u63A5\u53E3\u4E0D\u5B58\u5728"));
      return;
    }
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request2.headers.authorization ?? "")?.[1] ?? "";
    const url = new URL(request2.url ?? "/", "http://localhost");
    send(response, await service.feed(token, { after: url.searchParams.get("after") ?? "0", limit: Number(url.searchParams.get("limit") ?? 50) }));
  };
}

// server/adapters/postgres/campaign-repository.ts
var import_node_crypto19 = require("node:crypto");

// server/core/campaigns.ts
var CAMPAIGN_ROUTES = { campaigns: "/api/crm/campaigns", confirm: "confirm", pause: "pause", dryRunClaim: "dry-run-claim" };
var CAMPAIGN_LIMITS = { name: 200, key: 128, reason: 500, workerId: 128, page: 25, pageMax: 100, leaseSeconds: 300, claimBatch: 50, claimBatchMax: 100 };
var CAMPAIGN_STATES = ["draft", "scheduled", "running", "paused", "stopped", "completed"];
var CAMPAIGN_TARGET_STATES = ["pending", "leased", "blocked", "completed", "unknown", "revoked"];
var CAMPAIGN_ATTEMPT_STATES = ["planned", "accepted", "rejected", "unknown"];

// server/adapters/postgres/campaign-schema.ts
var CAMPAIGN_VERSION = "026-server-campaigns-n7-public";
var CAMPAIGN_LOCK = 19041026;
var quote = (v) => v.split(",").map((x) => `'${x}'`).join(",");
var CAMPAIGN_SQL = `
CREATE TABLE crm_campaigns(
 campaign_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),created_by uuid NOT NULL REFERENCES public.identity_users(user_id),name text NOT NULL CHECK(btrim(name)<>'' AND length(name)<=${CAMPAIGN_LIMITS.name}),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN (${quote(CAMPAIGN_STATES.join(","))})),version integer NOT NULL DEFAULT 1 CHECK(version>0),auto_send boolean NOT NULL DEFAULT false CHECK(auto_send=false),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND ${CAMPAIGN_LIMITS.key}),confirmed_at timestamptz,paused_at timestamptz,stopped_at timestamptz,stop_reason text CHECK(stop_reason IS NULL OR length(stop_reason)<=${CAMPAIGN_LIMITS.reason}),next_run_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(created_by,idempotency_key),
 CHECK((state='draft' AND confirmed_at IS NULL) OR (state<>'draft' AND confirmed_at IS NOT NULL)),CHECK((state='paused' AND paused_at IS NOT NULL) OR (state<>'paused' AND paused_at IS NULL))
);
CREATE INDEX idx_crm_campaigns_due ON crm_campaigns(next_run_at,campaign_id) WHERE state IN ('scheduled','running');
CREATE TABLE crm_campaign_targets(
 target_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),campaign_id uuid NOT NULL REFERENCES crm_campaigns(campaign_id) ON DELETE CASCADE,contact_id integer NOT NULL,customer_id uuid NOT NULL REFERENCES crm_customers(customer_id),contact_version integer NOT NULL CHECK(contact_version>0),round integer NOT NULL CHECK(round>=0),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN (${quote(CAMPAIGN_TARGET_STATES.join(","))})),next_touch_at timestamptz,lease_owner text,lease_until timestamptz,attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(campaign_id,contact_id,round),CHECK((state='leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL) OR state<>'leased')
);
CREATE INDEX idx_crm_campaign_targets_due ON crm_campaign_targets(next_touch_at,target_id) WHERE state='pending';
CREATE INDEX idx_crm_campaign_targets_lease ON crm_campaign_targets(lease_until,target_id) WHERE state='leased';
CREATE TABLE crm_campaign_attempts(
 attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),target_id uuid NOT NULL REFERENCES crm_campaign_targets(target_id),execution_key text NOT NULL UNIQUE,state text NOT NULL CHECK(state IN (${quote(CAMPAIGN_ATTEMPT_STATES.join(","))})),requested_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,error text
);
CREATE TABLE crm_campaign_receipts(
 receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),attempt_id uuid NOT NULL UNIQUE REFERENCES crm_campaign_attempts(attempt_id),state text NOT NULL CHECK(state IN ('accepted','rejected','unknown')),recorded_at timestamptz NOT NULL DEFAULT now(),detail text
);
CREATE INDEX idx_crm_campaign_attempts_target ON crm_campaign_attempts(target_id,requested_at);
`;

// server/adapters/postgres/campaign-repository.ts
var canManage3 = (a) => a.capabilities.includes("leads.develop");
var canRead = (a) => a.capabilities.includes("leads.read.all");
var iso = (v) => v instanceof Date ? v.toISOString() : String(v);
function campaignRow(r) {
  return { campaignId: String(r.campaignId), createdBy: String(r.createdBy), name: String(r.name), state: r.state, version: Number(r.version), autoSend: Boolean(r.autoSend), confirmedAt: r.confirmedAt ? iso(r.confirmedAt) : null, pausedAt: r.pausedAt ? iso(r.pausedAt) : null, stoppedAt: r.stoppedAt ? iso(r.stoppedAt) : null, stopReason: r.stopReason ? String(r.stopReason) : null, nextRunAt: r.nextRunAt ? iso(r.nextRunAt) : null, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) };
}
var PostgresCampaignRepository = class {
  constructor(pool, log) {
    this.pool = pool;
    this.log = log;
    assertCenterDatabasePool(pool);
  }
  async tx(fn) {
    let db;
    try {
      db = await this.pool.connect();
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK]);
      await db.query("SELECT pg_advisory_xact_lock($1)", [CAMPAIGN_LOCK]);
      const result2 = await fn(db);
      await db.query(result2.ok ? "COMMIT" : "ROLLBACK");
      return result2;
    } catch (error) {
      if (db)
        try {
          await db.query("ROLLBACK");
        } catch (rollbackError) {
          this.log.write("ERROR", "campaign.rollback", `\u4EFB\u52A1\u56DE\u6EDA\u5931\u8D25 ${rollbackError instanceof Error ? rollbackError.message : "UNKNOWN"}`);
        }
      this.log.write("ERROR", "campaign.pg", `\u4EFB\u52A1\u6570\u636E\u5E93\u64CD\u4F5C\u5931\u8D25 ${error instanceof Error ? error.message : "UNKNOWN"}`);
      return failure("DATABASE_ERROR", "\u4EFB\u52A1\u670D\u52A1\u6682\u4E0D\u53EF\u7528");
    } finally {
      db?.release();
    }
  }
  async authorized(hash, fn) {
    return this.tx(async (db) => {
      const a = await authorizeLeadActor(db, hash);
      return a ? fn(db, a) : failure("UNAUTHORIZED", "CRM\u4F1A\u8BDD\u6216\u4EA7\u54C1\u51C6\u5165\u5DF2\u5931\u6548");
    });
  }
  async one(db, id, a, lock = false) {
    const r = await db.query(`SELECT campaign_id AS "campaignId",created_by AS "createdBy",name,state,version,auto_send AS "autoSend",confirmed_at AS "confirmedAt",paused_at AS "pausedAt",stopped_at AS "stoppedAt",stop_reason AS "stopReason",next_run_at AS "nextRunAt",created_at AS "createdAt",updated_at AS "updatedAt" FROM crm_campaigns WHERE campaign_id=$1 ${lock ? "FOR UPDATE" : ""}`, [id]);
    if (!r.rows.length || !canRead(a) && r.rows[0].createdBy !== a.userId)
      return failure("NOT_FOUND", "\u4EFB\u52A1\u4E0D\u5B58\u5728");
    return success(campaignRow(r.rows[0]));
  }
  async migrate() {
    return this.tx(async (db) => {
      const hash = (0, import_node_crypto19.createHash)("sha256").update(CAMPAIGN_SQL).digest("hex");
      const old = await db.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [CAMPAIGN_VERSION]);
      if (old.rows.length && old.rows[0].checksum !== hash)
        return failure("CONFLICT", "\u81EA\u52A8\u5F00\u53D1\u4EFB\u52A1\u8FC1\u79FB\u6821\u9A8C\u4E0D\u4E00\u81F4");
      if (!old.rows.length) {
        await db.query(CAMPAIGN_SQL);
        await db.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)", [CAMPAIGN_VERSION, hash]);
        this.log.write("INFO", "campaign.migrate", `\u8FC1\u79FB\u5B8C\u6210 version=${CAMPAIGN_VERSION}`);
      }
      return success(void 0);
    });
  }
  create(hash, input) {
    return this.authorized(hash, async (db, a) => {
      if (!canManage3(a))
        return failure("FORBIDDEN", "\u65E0\u81EA\u52A8\u5F00\u53D1\u4EFB\u52A1\u6743\u9650");
      const old = await db.query('SELECT campaign_id AS "campaignId" FROM crm_campaigns WHERE created_by=$1 AND idempotency_key=$2', [a.userId, input.idempotencyKey]);
      if (old.rows.length)
        return this.one(db, old.rows[0].campaignId, a);
      const r = await db.query(`INSERT INTO crm_campaigns(created_by,name,idempotency_key,auto_send,next_run_at) VALUES($1,$2,$3,false,$4) RETURNING campaign_id`, [a.userId, input.name.trim(), input.idempotencyKey, input.nextRunAt ?? null]);
      return this.one(db, r.rows[0].campaign_id, a);
    });
  }
  detail(hash, id) {
    return this.authorized(hash, (db, a) => this.one(db, id, a));
  }
  list(hash, input) {
    return this.authorized(hash, async (db, a) => {
      if (!canRead(a))
        return failure("FORBIDDEN", "\u65E0\u81EA\u52A8\u5F00\u53D1\u4EFB\u52A1\u8BFB\u53D6\u6743\u9650");
      const params = [a.userId, input.state ?? null, input.limit, input.offset];
      const visibility2 = canRead(a) && a.capabilities.includes("leads.read.all") ? "TRUE" : "created_by=$1";
      const count = await db.query(`SELECT count(*)::int AS n FROM crm_campaigns WHERE ${visibility2} AND ($2::text IS NULL OR state=$2)`, params.slice(0, 2));
      const rows = await db.query(`SELECT campaign_id AS "campaignId",created_by AS "createdBy",name,state,version,auto_send AS "autoSend",confirmed_at AS "confirmedAt",paused_at AS "pausedAt",stopped_at AS "stoppedAt",stop_reason AS "stopReason",next_run_at AS "nextRunAt",created_at AS "createdAt",updated_at AS "updatedAt" FROM crm_campaigns WHERE ${visibility2} AND ($2::text IS NULL OR state=$2) ORDER BY created_at DESC,campaign_id LIMIT $3 OFFSET $4`, params);
      return success({ items: rows.rows.map(campaignRow), total: Number(count.rows[0].n) });
    });
  }
  confirm(hash, input) {
    return this.authorized(hash, async (db, a) => {
      if (!canManage3(a))
        return failure("FORBIDDEN", "\u65E0\u81EA\u52A8\u5F00\u53D1\u4EFB\u52A1\u6743\u9650");
      const current = await this.one(db, input.campaignId, a, true);
      if (!current.ok)
        return current;
      if (current.data.createdBy !== a.userId && !canRead(a))
        return failure("FORBIDDEN", "\u53EA\u80FD\u786E\u8BA4\u81EA\u5DF1\u7684\u4EFB\u52A1");
      if (current.data.version !== input.expectedVersion || current.data.state !== "draft")
        return failure("CONFLICT", "\u4EFB\u52A1\u5DF2\u53D8\u5316\u6216\u4E0D\u662F\u8349\u7A3F");
      const r = await db.query(`UPDATE crm_campaigns SET state='scheduled',confirmed_at=clock_timestamp(),version=version+1,next_run_at=COALESCE(next_run_at,clock_timestamp()),updated_at=clock_timestamp() WHERE campaign_id=$1 AND version=$2 RETURNING campaign_id`, [input.campaignId, input.expectedVersion]);
      if (!r.rows.length)
        return failure("CONFLICT", "\u4EFB\u52A1\u7248\u672C\u5DF2\u53D8\u5316");
      return this.one(db, input.campaignId, a);
    });
  }
  pause(hash, input) {
    return this.authorized(hash, async (db, a) => {
      if (!canManage3(a))
        return failure("FORBIDDEN", "\u65E0\u81EA\u52A8\u5F00\u53D1\u4EFB\u52A1\u6743\u9650");
      const current = await this.one(db, input.campaignId, a, true);
      if (!current.ok)
        return current;
      if (current.data.createdBy !== a.userId && !canRead(a))
        return failure("FORBIDDEN", "\u53EA\u80FD\u6682\u505C\u81EA\u5DF1\u7684\u4EFB\u52A1");
      if (current.data.version !== input.expectedVersion || !["scheduled", "running"].includes(current.data.state))
        return failure("CONFLICT", "\u4EFB\u52A1\u5DF2\u53D8\u5316\u6216\u4E0D\u53EF\u6682\u505C");
      const r = await db.query(`UPDATE crm_campaigns SET state='paused',paused_at=clock_timestamp(),stop_reason=$3,version=version+1,updated_at=clock_timestamp() WHERE campaign_id=$1 AND version=$2 RETURNING campaign_id`, [input.campaignId, input.expectedVersion, input.reason?.trim() || null]);
      if (!r.rows.length)
        return failure("CONFLICT", "\u4EFB\u52A1\u7248\u672C\u5DF2\u53D8\u5316");
      return this.one(db, input.campaignId, a);
    });
  }
  addTargets(hash, input) {
    return this.authorized(hash, async (db, a) => {
      if (!canManage3(a))
        return failure("FORBIDDEN", "\u65E0\u81EA\u52A8\u5F00\u53D1\u4EFB\u52A1\u6743\u9650");
      const c = await this.one(db, input.campaignId, a, true);
      if (!c.ok)
        return c;
      if (c.data.createdBy !== a.userId && !canRead(a))
        return failure("FORBIDDEN", "\u53EA\u80FD\u4FEE\u6539\u81EA\u5DF1\u7684\u4EFB\u52A1");
      if (c.data.version !== input.expectedVersion || c.data.state !== "draft")
        return failure("CONFLICT", "\u53EA\u6709\u672A\u786E\u8BA4\u8349\u7A3F\u53EF\u4EE5\u6DFB\u52A0\u89E6\u70B9");
      const digest = (0, import_node_crypto19.createHash)("sha256").update(JSON.stringify(input.targets)).digest("hex");
      const idem = await db.query("SELECT response,digest FROM crm_lead_idempotency WHERE actor_id=$1 AND operation=$2 AND key=$3", [a.userId, `campaign:targets:${input.campaignId}`, input.idempotencyKey]);
      if (idem.rows.length) {
        if (idem.rows[0].digest !== digest)
          return failure("CONFLICT", "\u5E42\u7B49\u952E\u5DF2\u7528\u4E8E\u4E0D\u540C\u8BF7\u6C42");
        return success(Number(idem.rows[0].response.count));
      }
      for (const t of input.targets)
        await db.query(`INSERT INTO crm_campaign_targets(campaign_id,contact_id,customer_id,contact_version,round,next_touch_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(campaign_id,contact_id,round) DO NOTHING`, [input.campaignId, t.contactId, t.customerId, t.contactVersion, t.round, t.nextTouchAt]);
      const count = await db.query("SELECT count(*)::int AS n FROM crm_campaign_targets WHERE campaign_id=$1", [input.campaignId]);
      await db.query("INSERT INTO crm_lead_idempotency(actor_id,operation,key,digest,response) VALUES($1,$2,$3,$4,$5)", [a.userId, `campaign:targets:${input.campaignId}`, input.idempotencyKey, digest, JSON.stringify({ count: Number(count.rows[0].n) })]);
      return success(Number(count.rows[0].n));
    });
  }
  claimDryRun(hash, input) {
    return this.authorized(hash, async (db, a) => {
      if (!canRead(a))
        return failure("FORBIDDEN", "\u4EC5\u53D7\u63A7\u4EFB\u52A1Worker\u53EF\u9886\u53D6");
      const rows = await db.query(`SELECT t.target_id AS "targetId",t.campaign_id AS "campaignId",t.contact_id AS "contactId",t.customer_id AS "customerId",t.contact_version AS "contactVersion",t.round,t.state,t.next_touch_at AS "nextTouchAt",t.attempt_count AS "attemptCount",t.last_error AS "lastError",c.created_by AS "createdBy" FROM crm_campaign_targets t JOIN crm_campaigns c USING(campaign_id) WHERE c.state IN ('scheduled','running') AND t.state='pending' AND t.next_touch_at<=clock_timestamp() AND (c.created_by=$2 OR $3) ORDER BY t.next_touch_at,t.target_id LIMIT $1 FOR UPDATE OF t SKIP LOCKED`, [Math.min(input.limit, CAMPAIGN_LIMITS.claimBatchMax), a.userId, canRead(a)]);
      const out = [];
      for (const row2 of rows.rows) {
        const executionKey = `dry-run:${row2.targetId}:${Number(row2.attemptCount) + 1}`;
        const leaseUntil = new Date(Date.now() + CAMPAIGN_LIMITS.leaseSeconds * 1e3).toISOString();
        const attempt = await db.query(`INSERT INTO crm_campaign_attempts(target_id,execution_key,state) VALUES($1,$2,'planned') ON CONFLICT(execution_key) DO NOTHING RETURNING attempt_id`, [row2.targetId, executionKey]);
        if (!attempt.rows.length)
          continue;
        await db.query(`UPDATE crm_campaign_targets SET state='leased',lease_owner=$2,lease_until=$3,attempt_count=attempt_count+1,updated_at=clock_timestamp() WHERE target_id=$1`, [row2.targetId, input.workerId, leaseUntil]);
        out.push({ ...row2, state: "leased", leaseOwner: input.workerId, leaseUntil, attemptCount: Number(row2.attemptCount) + 1, attemptId: attempt.rows[0].attempt_id, executionKey, dryRun: true, nextTouchAt: row2.nextTouchAt ? iso(row2.nextTouchAt) : null });
      }
      return success(out);
    });
  }
  completeDryRun(hash, input) {
    return this.authorized(hash, async (db, a) => {
      if (!canManage3(a))
        return failure("FORBIDDEN", "\u65E0\u81EA\u52A8\u5F00\u53D1\u4EFB\u52A1\u6743\u9650");
      const attempt = await db.query(`SELECT a.attempt_id,a.target_id,a.state AS attempt_state,t.campaign_id,t.contact_id,t.customer_id,t.contact_version,c.created_by,c.state AS campaign_state,cc.contact_id AS linked_contact_id,ct.crm_contact_version,ct.crm_deleted_at FROM crm_campaign_attempts a JOIN crm_campaign_targets t USING(target_id) JOIN crm_campaigns c USING(campaign_id) LEFT JOIN crm_customer_contacts cc ON cc.customer_id=t.customer_id AND cc.contact_id=t.contact_id LEFT JOIN contacts ct ON ct.id=t.contact_id WHERE a.attempt_id=$1 AND a.execution_key=$2 FOR UPDATE OF a,t`, [input.attemptId, input.executionKey]);
      if (!attempt.rows.length)
        return failure("NOT_FOUND", "\u6267\u884C\u5C1D\u8BD5\u4E0D\u5B58\u5728");
      const row2 = attempt.rows[0];
      if (row2.created_by !== a.userId && !canRead(a))
        return failure("FORBIDDEN", "\u53EA\u80FD\u56DE\u6267\u81EA\u5DF1\u7684\u4EFB\u52A1");
      if (row2.attempt_state !== "planned")
        return success(void 0);
      const authorizedTarget = row2.linked_contact_id !== null && row2.crm_contact_version === row2.contact_version && row2.crm_deleted_at === null;
      const effective = input.state === "accepted" && authorizedTarget && ["scheduled", "running"].includes(row2.campaign_state) ? "accepted" : input.state === "unknown" ? "unknown" : "rejected";
      const detail = effective === "rejected" ? input.error?.trim() || (authorizedTarget ? "\u4EFB\u52A1\u5DF2\u6682\u505C\u6216\u6388\u6743\u5931\u6548" : "\u8054\u7CFB\u4EBA\u5DF2\u64A4\u6743\u6216\u7248\u672C\u5DF2\u53D8\u5316") : input.error?.trim() || null;
      const targetState = effective === "accepted" ? "completed" : effective === "unknown" ? "unknown" : "blocked";
      await db.query(`UPDATE crm_campaign_attempts SET state=$2,completed_at=clock_timestamp(),error=$3 WHERE attempt_id=$1`, [input.attemptId, effective, detail]);
      await db.query(`INSERT INTO crm_campaign_receipts(attempt_id,state,detail) VALUES($1,$2,$3)`, [input.attemptId, effective, detail]);
      await db.query(`UPDATE crm_campaign_targets SET state=$2,lease_owner=NULL,lease_until=NULL,last_error=$3,updated_at=clock_timestamp() WHERE target_id=$1`, [row2.target_id, targetState, detail]);
      return success(void 0);
    });
  }
};

// server/services/campaigns.ts
var UUID11 = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
var TOKEN2 = /^[A-Za-z0-9_-]{43}$/;
function record9(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function text8(v, max, min = 1) {
  return typeof v === "string" && v.trim().length >= min && v.length <= max && !v.includes("\0");
}
function positive6(v) {
  return Number.isSafeInteger(v) && Number(v) > 0;
}
function run(token, tokens, fn) {
  return TOKEN2.test(token) ? fn(tokens.hash(token)) : Promise.resolve(failure("UNAUTHORIZED", "\u4F1A\u8BDD\u65E0\u6548"));
}
function command3(v) {
  return record9(v) && UUID11.test(String(v.campaignId)) && positive6(v.expectedVersion) && text8(v.idempotencyKey, CAMPAIGN_LIMITS.key);
}
function createCampaignService(repository, tokens) {
  const tokenPort = tokens ?? { hash: (v) => v };
  return {
    create(token, v) {
      if (!record9(v) || !text8(v.name, CAMPAIGN_LIMITS.name) || !text8(v.idempotencyKey, CAMPAIGN_LIMITS.key) || v.autoSend !== void 0 && typeof v.autoSend !== "boolean" || v.nextRunAt !== void 0 && (typeof v.nextRunAt !== "string" || !Number.isFinite(Date.parse(v.nextRunAt))))
        return Promise.resolve(failure("INVALID_INPUT", "\u4E2D\u5FC3\u4EFB\u52A1\u53C2\u6570\u65E0\u6548"));
      const value2 = v;
      return run(token, tokenPort, (h) => repository.create(h, { name: value2.name.trim(), idempotencyKey: value2.idempotencyKey, autoSend: false, nextRunAt: value2.nextRunAt }));
    },
    detail(token, id) {
      return UUID11.test(id) ? run(token, tokenPort, (h) => repository.detail(h, id)) : Promise.resolve(failure("NOT_FOUND", "\u4EFB\u52A1\u4E0D\u5B58\u5728"));
    },
    list(token, v) {
      if (!record9(v) || !positive6(v.limit) || Number(v.limit) > CAMPAIGN_LIMITS.pageMax || !Number.isSafeInteger(v.offset) || Number(v.offset) < 0 || v.state !== void 0 && !CAMPAIGN_STATES.includes(v.state))
        return Promise.resolve(failure("INVALID_INPUT", "\u4E2D\u5FC3\u4EFB\u52A1\u5217\u8868\u53C2\u6570\u65E0\u6548"));
      return run(token, tokenPort, (h) => repository.list(h, { limit: Number(v.limit), offset: Number(v.offset), ...v.state ? { state: v.state } : {} }));
    },
    confirm(token, v) {
      if (!command3(v))
        return Promise.resolve(failure("INVALID_INPUT", "\u4EFB\u52A1\u786E\u8BA4\u53C2\u6570\u65E0\u6548"));
      return run(token, tokenPort, (h) => repository.confirm(h, v));
    },
    pause(token, v) {
      if (!command3(v) || !record9(v) || v.reason !== void 0 && !text8(v.reason, CAMPAIGN_LIMITS.reason, 0))
        return Promise.resolve(failure("INVALID_INPUT", "\u4EFB\u52A1\u6682\u505C\u53C2\u6570\u65E0\u6548"));
      return run(token, tokenPort, (h) => repository.pause(h, v));
    },
    addTargets(token, v) {
      if (!record9(v) || !UUID11.test(String(v.campaignId)) || !positive6(v.expectedVersion) || !text8(v.idempotencyKey, CAMPAIGN_LIMITS.key) || !Array.isArray(v.targets) || v.targets.length < 1 || v.targets.length > CAMPAIGN_LIMITS.claimBatchMax || !v.targets.every((t) => record9(t) && Number.isSafeInteger(t.contactId) && Number(t.contactId) > 0 && UUID11.test(String(t.customerId)) && positive6(t.contactVersion) && Number.isSafeInteger(t.round) && Number(t.round) >= 0 && typeof t.nextTouchAt === "string" && Number.isFinite(Date.parse(t.nextTouchAt))))
        return Promise.resolve(failure("INVALID_INPUT", "\u4EFB\u52A1\u89E6\u70B9\u53C2\u6570\u65E0\u6548"));
      return run(token, tokenPort, (h) => repository.addTargets(h, v));
    },
    claimDryRun(token, v) {
      if (!record9(v) || !positive6(v.limit) || Number(v.limit) > CAMPAIGN_LIMITS.claimBatchMax || !text8(v.workerId, CAMPAIGN_LIMITS.workerId))
        return Promise.resolve(failure("INVALID_INPUT", "\u4EFB\u52A1\u9886\u53D6\u53C2\u6570\u65E0\u6548"));
      const value2 = v;
      return run(token, tokenPort, (h) => repository.claimDryRun(h, { limit: Number(value2.limit), workerId: value2.workerId.trim() }));
    },
    completeDryRun(token, v) {
      if (!record9(v) || !UUID11.test(String(v.attemptId)) || !text8(v.executionKey, CAMPAIGN_LIMITS.key) || !["accepted", "rejected", "unknown"].includes(String(v.state)) || v.error !== void 0 && !text8(v.error, CAMPAIGN_LIMITS.reason, 0))
        return Promise.resolve(failure("INVALID_INPUT", "\u4EFB\u52A1\u8BD5\u8FD0\u884C\u56DE\u6267\u65E0\u6548"));
      return run(token, tokenPort, (h) => repository.completeDryRun(h, v));
    }
  };
}

// server/transport/campaigns-http.ts
function createCampaignHandler(service) {
  return async (request2, response) => {
    const url = new URL(request2.url ?? "/", "http://localhost"), token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request2.headers.authorization ?? "")?.[1] ?? "";
    const prefix = `${CAMPAIGN_ROUTES.campaigns}/`, parts = url.pathname.slice(prefix.length).split("/");
    if (request2.method === "GET" && url.pathname === CAMPAIGN_ROUTES.campaigns) {
      send(response, await service.list(token, { limit: Number(url.searchParams.get("limit") ?? CAMPAIGN_LIMITS.page), offset: Number(url.searchParams.get("offset") ?? 0), ...url.searchParams.has("state") ? { state: url.searchParams.get("state") } : {} }));
      return;
    }
    if (request2.method === "GET" && url.pathname.startsWith(prefix) && parts.length === 1) {
      send(response, await service.detail(token, parts[0]));
      return;
    }
    if (request2.method === "POST") {
      const input = await body(request2, 4096);
      if (!input.ok) {
        send(response, input);
        return;
      }
      if (url.pathname === CAMPAIGN_ROUTES.campaigns) {
        send(response, await service.create(token, input.data));
        return;
      }
      if (parts.length === 2 && parts[1] === CAMPAIGN_ROUTES.confirm) {
        send(response, await service.confirm(token, { ...input.data, campaignId: parts[0] }));
        return;
      }
      if (parts.length === 2 && parts[1] === CAMPAIGN_ROUTES.pause) {
        send(response, await service.pause(token, { ...input.data, campaignId: parts[0] }));
        return;
      }
      if (parts.length === 2 && parts[1] === "targets") {
        send(response, await service.addTargets(token, { ...input.data, campaignId: parts[0] }));
        return;
      }
      if (url.pathname === `${CAMPAIGN_ROUTES.campaigns}/${CAMPAIGN_ROUTES.dryRunClaim}`) {
        send(response, await service.claimDryRun(token, input.data));
        return;
      }
      if (parts.length === 2 && parts[1] === "dry-run-complete") {
        send(response, await service.completeDryRun(token, input.data));
        return;
      }
    }
    send(response, failure("NOT_FOUND", "\u81EA\u52A8\u5F00\u53D1\u4EFB\u52A1\u63A5\u53E3\u4E0D\u5B58\u5728"));
  };
}

// server/online.ts
var EXIT_FAILED = 1;
var SHUTDOWN_TIMEOUT_MS = 5e3;
async function main() {
  const config = readOnlineConfig(), pool = new Pool(readOnlineDatabaseConfig());
  let started = false;
  try {
    const crm = new PostgresCrmRepository(pool, serverLog), repo = new PostgresAuthRepository(pool, serverLog);
    if (!(await crm.migrate()).ok || !(await repo.migrate()).ok)
      throw new Error("\u8FC1\u79FB\u88AB\u62D2\u7EDD");
    const passwords = new PasswordAdapter(config.password_concurrency);
    await passwords.initialize();
    await initializeFixtures(repo, passwords, config.test_mode);
    const clock = { now: () => Date.now() }, instanceId = process.env.PROSPECTOR_ONLINE_INSTANCE;
    if (!instanceId || !/^[a-f0-9]{64}$/.test(instanceId))
      throw new Error("\u7F3A\u5C11\u672C\u8282\u70B9\u542F\u52A8\u6807\u8BC6");
    const auth = createAuthService(repo, passwords, tokenAdapter, clock, config.session_ttl_seconds);
    const adminRepository = new PostgresAdminRepository(pool, serverLog);
    const admin = createAdminService(adminRepository, repo, passwords, tokenAdapter, clock, auth);
    const dashboard = createManagementDashboardService(adminRepository, tokenAdapter);
    const dataBrowser = createAdminDataBrowserService(adminRepository, tokenAdapter);
    const gate = new LoginRateGate(config, clock);
    const leadRepo = new PostgresLeadRepository(pool, serverLog), notificationRepo = new PostgresNotificationRepository(pool, serverLog);
    if (!(await leadRepo.migrate()).ok || !(await notificationRepo.migrate()).ok)
      throw new Error("\u534F\u4F5C\u8FC1\u79FB\u88AB\u62D2\u7EDD");
    const assignmentGroupClient = await pool.connect();
    try {
      if (!(await migrateContactAssignmentGroups(assignmentGroupClient)).ok)
        throw new Error("\u5206\u914D\u7EC4\u8FC1\u79FB\u88AB\u62D2\u7EDD");
    } finally {
      assignmentGroupClient.release();
    }
    const taskRepo = new PostgresTaskRepository(pool, serverLog);
    if (!(await taskRepo.migrate()).ok)
      throw new Error("\u4EFB\u52A1\u8FC1\u79FB\u88AB\u62D2\u7EDD");
    const opportunityRepo = new PostgresOpportunityRepository(pool, serverLog);
    if (!(await opportunityRepo.migrate()).ok)
      throw new Error("\u5546\u673A\u8FC1\u79FB\u88AB\u62D2\u7EDD");
    const contactChangeRepo = new PostgresContactChangeRepository(pool, serverLog);
    if (!(await contactChangeRepo.migrate()).ok)
      throw new Error("\u8054\u7CFB\u4EBA\u53D8\u5316\u8FC1\u79FB\u88AB\u62D2\u7EDD");
    const campaignRepo = new PostgresCampaignRepository(pool, serverLog);
    if (!(await campaignRepo.migrate()).ok)
      throw new Error("\u81EA\u52A8\u5F00\u53D1\u4EFB\u52A1\u8FC1\u79FB\u88AB\u62D2\u7EDD");
    const opportunities = createOpportunityHandler(createOpportunityService(opportunityRepo, tokenAdapter));
    const taskService = createTaskService(taskRepo, tokenAdapter);
    const tasks = createTaskHandler(taskService);
    const contactShares = createContactSharingHandler(createContactSharingService(leadRepo, tokenAdapter));
    const contactAssignments = createContactAssignmentHandler(createContactAssignmentService(leadRepo, tokenAdapter));
    const sendAcceptance2 = createSendAcceptanceHandler(createSendAcceptanceService(leadRepo, tokenAdapter));
    const contactMail = createContactMailHandler(createContactMailService(leadRepo, tokenAdapter));
    const leads = createCrmHandler(createLeadService(leadRepo, tokenAdapter));
    const notifications = createEventsHandler(createNotificationService(notificationRepo, tokenAdapter));
    const contactChanges = createContactChangeHandler(createContactChangeService(contactChangeRepo, tokenAdapter));
    const campaigns = createCampaignHandler(createCampaignService(campaignRepo, tokenAdapter));
    const collaboration = async (request2, response) => {
      const route = new URL(request2.url ?? "/", "http://localhost").pathname;
      if (Object.values(SEND_ACCEPTANCE_ROUTES).some((path4) => path4 === route)) {
        await sendAcceptance2(request2, response);
        return;
      }
      if (route === CONTACT_MAIL_ROUTE) {
        await contactMail(request2, response);
        return;
      }
      if (route === "/api/crm/contact-shares" || route.startsWith("/api/crm/contact-shares/")) {
        await contactShares(request2, response);
        return;
      }
      if (route === "/api/crm/companies" || route.startsWith("/api/crm/companies/") || route === "/api/crm/contacts/delete" || route === CONTACT_ASSIGNMENT_ROUTES.assignments || route.startsWith(`${CONTACT_ASSIGNMENT_ROUTES.assignments}/`) || route === CONTACT_ASSIGNMENT_ROUTES.groups || route.startsWith(`${CONTACT_ASSIGNMENT_ROUTES.groups}/`) || route.startsWith("/api/crm/contacts/")) {
        await contactAssignments(request2, response);
        return;
      }
      if (route === TASK_ROUTES.tasks || route.startsWith(`${TASK_ROUTES.tasks}/`)) {
        await tasks(request2, response);
        return;
      }
      if (route === OPPORTUNITY_ROUTES.opportunities || route.startsWith(`${OPPORTUNITY_ROUTES.opportunities}/`)) {
        await opportunities(request2, response);
        return;
      }
      if (route === CONTACT_CHANGE_ROUTE) {
        await contactChanges(request2, response);
        return;
      }
      if (route === CAMPAIGN_ROUTES.campaigns || route.startsWith(`${CAMPAIGN_ROUTES.campaigns}/`)) {
        await campaigns(request2, response);
        return;
      }
      await (route === NOTIFICATION_ROUTES.events || route === NOTIFICATION_ROUTES.feed || route.startsWith(`${NOTIFICATION_ROUTES.feed}/`) ? notifications : leads)(request2, response);
    };
    const offlineIssuer = loadOfflineAccessIssuer(onlineRuntimeDirectory(), config.public_origin ?? `http://${config.host}:${config.port}`);
    const desktop = createDesktopAuthHandler(createDesktopSessionService(repo, passwords, tokenAdapter, clock, config.session_ttl_seconds, offlineIssuer), gate, config);
    const server = createOnlineServer(auth, gate, config, serverLog, instanceId, createAdminHandler(auth, admin, tokenAdapter, gate, config, createAdminStatic(), createPasswordChangeService(repo, repo, passwords, tokenAdapter, auth), dashboard, dataBrowser), collaboration, desktop);
    await new Promise((resolve3, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, resolve3);
    });
    started = true;
    const dispatcher = startNotificationDispatcher(notificationRepo, serverLog);
    const taskDispatcher = startTaskDispatcher(taskService, serverLog);
    serverLog.write("INFO", "identity.runtime", `\u4E2D\u5FC3\u670D\u52A1\u5C31\u7EEA ${config.host}:${config.port}`);
    let closing = false;
    const stop = () => {
      if (closing)
        return;
      closing = true;
      const timer = setTimeout(() => {
        server.closeAllConnections();
      }, SHUTDOWN_TIMEOUT_MS);
      server.close(() => {
        clearTimeout(timer);
        void Promise.all([taskDispatcher.stop(), dispatcher.stop()]).then(() => pool.end()).catch(() => {
          serverLog.write("ERROR", "identity.runtime", "\u8FDE\u63A5\u6C60\u5173\u95ED\u5931\u8D25");
          process.exitCode = EXIT_FAILED;
        });
      });
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    server.on("error", () => {
      serverLog.write("ERROR", "identity.runtime", "\u670D\u52A1\u8FD0\u884C\u9519\u8BEF");
      process.exitCode = EXIT_FAILED;
      stop();
    });
  } finally {
    if (!started)
      await pool.end();
  }
}
void main().catch((error) => {
  const message = error instanceof Error ? error.message : "\u672A\u77E5\u9519\u8BEF";
  serverLog.write("ERROR", "identity.runtime", `\u4E2D\u5FC3\u542F\u52A8\u5931\u8D25\uFF1A${message}`);
  process.exitCode = EXIT_FAILED;
});
