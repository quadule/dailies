import { PAGE_INTERACTIONS_SOURCE } from "./interactions.js";

export const TRANSPORT_RECEIVE_GLOBAL = "__transport_receive";
const WAIT_FOR_OBJECT_ATTEMPTS = 1000;

// Capture the bridge hooks in a private closure before removing them from the
// guest globals. Only the frozen browser API and controlled file helpers survive.
export const SANDBOX_BOOTSTRAP_SOURCE = `
          (() => {
            const hostCall = globalThis.__hostCall;
            const transportSend = globalThis.__transport_send;
            const createPlaywrightClient = globalThis.__createPlaywrightClient;

            if (typeof hostCall !== "function") {
              throw new Error("Sandbox bridge did not expose a host-call function");
            }
            if (typeof transportSend !== "function") {
              throw new Error("Sandbox bridge did not expose a transport sender");
            }
            if (typeof createPlaywrightClient !== "function") {
              throw new Error("Sandbox client bundle did not expose a Playwright client factory");
            }

            if (!delete globalThis.__hostCall) {
              globalThis.__hostCall = undefined;
            }
            if (!delete globalThis.__transport_send) {
              globalThis.__transport_send = undefined;
            }
            if (!delete globalThis.__createPlaywrightClient) {
              globalThis.__createPlaywrightClient = undefined;
            }

            const playwrightClient = createPlaywrightClient();
            const connection = new playwrightClient.Connection(playwrightClient.quickjsPlatform);
            connection.onmessage = (message) => {
              transportSend(JSON.stringify(message));
            };

            Object.defineProperty(globalThis, "${TRANSPORT_RECEIVE_GLOBAL}", {
              value: (json) => {
                connection.dispatch(JSON.parse(json));
              },
              configurable: false,
              enumerable: false,
              writable: false,
            });

            const waitForConnectionObject = async (guid, label) => {
              if (typeof guid !== "string" || guid.length === 0) {
                throw new Error(\`\${label} did not return a valid guid\`);
              }

              for (let attempt = 0; attempt < ${WAIT_FOR_OBJECT_ATTEMPTS}; attempt += 1) {
                const object = connection.getObjectWithKnownName(guid);
                if (object) {
                  return object;
                }
                await new Promise((resolve) => setTimeout(resolve, 0));
              }

              throw new Error(\`Timed out waiting for \${label} (\${guid}) in the sandbox\`);
            };

            const encodeHostFilePayload = (value) => {
              if (typeof value === "string") {
                return { encoding: "utf8", data: value };
              }
              if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
                return { encoding: "base64", data: Buffer.from(value).toString("base64") };
              }
              throw new TypeError(
                "File data must be a string, Buffer, Uint8Array, or ArrayBuffer",
              );
            };

${PAGE_INTERACTIONS_SOURCE}            return (async () => {
              await connection.initializePlaywright();

              const browserApi = Object.create(null);
              Object.defineProperties(browserApi, {
                getPage: {
                  value: async (name) => {
                    const guid = await hostCall("getPage", JSON.stringify([name]));
                    return augmentPage(await waitForConnectionObject(guid, \`page "\${name}"\`));
                  },
                  enumerable: true,
                },
                newPage: {
                  value: async () => {
                    const guid = await hostCall("newPage", JSON.stringify([]));
                    return augmentPage(await waitForConnectionObject(guid, "anonymous page"));
                  },
                  enumerable: true,
                },
                listPages: {
                  value: async () => {
                    return await hostCall("listPages", JSON.stringify([]));
                  },
                  enumerable: true,
                },
                closePage: {
                  value: async (name) => {
                    await hostCall("closePage", JSON.stringify([name]));
                  },
                  enumerable: true,
                },
              });
              Object.freeze(browserApi);

              Object.defineProperty(globalThis, "browser", {
                value: browserApi,
                configurable: false,
                enumerable: true,
                writable: false,
              });

              Object.defineProperties(globalThis, {
                saveScreenshot: {
                  value: async (buffer, name) => {
                    return await hostCall(
                      "saveScreenshot",
                      JSON.stringify([name, encodeHostFilePayload(buffer)]),
                    );
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
                writeFile: {
                  value: async (name, data) => {
                    return await hostCall(
                      "writeFile",
                      JSON.stringify([name, encodeHostFilePayload(data)]),
                    );
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
                readFile: {
                  value: async (name) => {
                    return await hostCall("readFile", JSON.stringify([name]));
                  },
                  configurable: false,
                  enumerable: true,
                  writable: false,
                },
              });
            })();
          })()
        `;

// Serialize the client bundle as data so template syntax inside it stays intact.
export function createClientFactorySource(bundleCode: string): string {
  const bundleFactorySource = JSON.stringify(
    `${bundleCode}\nreturn __PlaywrightClient;`
  );
  return `
          globalThis.__createPlaywrightClient = () => {
            return new Function(${bundleFactorySource})();
          };
        `;
}
