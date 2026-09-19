// Runtime shims evaluated inside QuickJS before loading the Playwright client.
// Keep this explicit guest source: host globals and imports must never leak in.
export const QUICKJS_RUNTIME_SOURCE = `
          const __performanceOrigin = Date.now();
          const __base64Alphabet =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

          const __encodeBase64 = (bytes) => {
            let result = "";
            for (let index = 0; index < bytes.length; index += 3) {
              const chunk =
                (bytes[index] << 16) |
                ((bytes[index + 1] ?? 0) << 8) |
                (bytes[index + 2] ?? 0);
              result += __base64Alphabet[(chunk >> 18) & 63];
              result += __base64Alphabet[(chunk >> 12) & 63];
              result += index + 1 < bytes.length ? __base64Alphabet[(chunk >> 6) & 63] : "=";
              result += index + 2 < bytes.length ? __base64Alphabet[chunk & 63] : "=";
            }
            return result;
          };

          const __decodeBase64 = (base64) => {
            const normalized = String(base64).replace(/\\s+/g, "");
            const output = [];
            for (let index = 0; index < normalized.length; index += 4) {
              const a = __base64Alphabet.indexOf(normalized[index] ?? "A");
              const b = __base64Alphabet.indexOf(normalized[index + 1] ?? "A");
              const c =
                normalized[index + 2] === "="
                  ? 64
                  : __base64Alphabet.indexOf(normalized[index + 2] ?? "A");
              const d =
                normalized[index + 3] === "="
                  ? 64
                  : __base64Alphabet.indexOf(normalized[index + 3] ?? "A");
              const chunk = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
              output.push((chunk >> 16) & 255);
              if (c !== 64) {
                output.push((chunk >> 8) & 255);
              }
              if (d !== 64) {
                output.push(chunk & 255);
              }
            }
            return new Uint8Array(output);
          };

          globalThis.URL ??= class URL {
            constructor(value, base) {
              this.href = base === undefined ? String(value) : String(base) + String(value);
            }

            toJSON() {
              return this.href;
            }

            toString() {
              return this.href;
            }
          };

          globalThis.Buffer ??= class Buffer extends Uint8Array {
            constructor(value, byteOffset, length) {
              if (typeof value === "number") {
                super(value);
                return;
              }
              if (value instanceof ArrayBuffer) {
                super(value, byteOffset, length);
                return;
              }
              if (ArrayBuffer.isView(value)) {
                super(value.buffer, value.byteOffset, value.byteLength);
                return;
              }
              super(value);
            }

            static from(value, encodingOrOffset, length) {
              if (typeof value === "string") {
                if (encodingOrOffset !== undefined && encodingOrOffset !== "base64") {
                  throw new Error("QuickJS Buffer only supports base64 string input");
                }
                return new Buffer(__decodeBase64(value));
              }
              if (value instanceof ArrayBuffer) {
                return new Buffer(value, encodingOrOffset, length);
              }
              if (ArrayBuffer.isView(value)) {
                return new Buffer(
                  value.buffer.slice(
                    value.byteOffset,
                    value.byteOffset + value.byteLength,
                  ),
                );
              }
              if (Array.isArray(value)) {
                return new Buffer(value);
              }
              throw new TypeError("Unsupported Buffer.from input");
            }

            toString(encoding) {
              if (encoding === undefined || encoding === "utf8") {
                return Array.from(this)
                  .map((value) => String.fromCharCode(value))
                  .join("");
              }
              if (encoding === "base64") {
                return __encodeBase64(this);
              }
              throw new Error("QuickJS Buffer only supports utf8 and base64 output");
            }
          };

          globalThis.performance ??= {
            now: () => Date.now() - __performanceOrigin,
            timeOrigin: __performanceOrigin,
          };
          globalThis.global = globalThis;
        `;
