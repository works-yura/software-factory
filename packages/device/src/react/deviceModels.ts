import {
  resolveDeviceModelId,
  type DeviceAccessorySource,
  type DeviceModelId,
  type DeviceModelSource,
} from "../client/model.ts";
import type { DevicePlatform } from "../contracts.ts";

export type DeviceModelAssetId = DeviceModelId | DeviceAccessorySource["id"];

/** Where the host serves each 3D device asset (`models/*.glb`). A missing model shows the flat-shaded frame. */
export type DeviceModelUrls = Record<DeviceModelAssetId, string>;

/**
 * The bundled models, resolved next to this module. Vite (and other bundlers that
 * understand `new URL(…, import.meta.url)`) copy the files and rewrite these URLs.
 */
export function defaultDeviceModelUrls(): DeviceModelUrls {
  return {
    "iphone-duo": new URL("./models/iphone-duo.glb", import.meta.url).href,
    "iphone-18-pro": new URL("./models/iphone-18-pro.glb", import.meta.url).href,
    "iphone-18-pro-max": new URL("./models/iphone-18-pro-max.glb", import.meta.url).href,
    "ipad-pro-13-m5": new URL("./models/ipad-pro-13-m5.glb", import.meta.url).href,
    "ipad-pro-13-m5-magic-keyboard": new URL(
      "./models/ipad-pro-13-m5-magic-keyboard.glb",
      import.meta.url,
    ).href,
  };
}

// Stable sources per URL: the 3D viewers reload their model when the source changes.
const sources = new Map<string, DeviceModelSource | DeviceAccessorySource>();
function cached<T extends DeviceModelSource | DeviceAccessorySource>(source: T): T {
  const key = `${source.id}\u0000${source.url}`;
  const existing = sources.get(key);
  if (existing) return existing as T;
  sources.set(key, source);
  return source;
}

export function deviceModel(
  platform: DevicePlatform,
  name: string,
  urls: Partial<DeviceModelUrls> | null,
): DeviceModelSource | null {
  const id = resolveDeviceModelId(platform, name);
  const url = id ? urls?.[id] : undefined;
  return id && url ? cached({ id, url }) : null;
}

export function deviceKeyboard(
  platform: DevicePlatform,
  name: string,
  urls: Partial<DeviceModelUrls> | null,
): DeviceAccessorySource | null {
  const url = urls?.["ipad-pro-13-m5-magic-keyboard"];
  return url && resolveDeviceModelId(platform, name) === "ipad-pro-13-m5"
    ? cached({ id: "ipad-pro-13-m5-magic-keyboard", modelId: "ipad-pro-13-m5", url })
    : null;
}
