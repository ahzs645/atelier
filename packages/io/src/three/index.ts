import type * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    output += BASE64[a >> 2];
    output += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    output += b === undefined
      ? "="
      : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    output += c === undefined ? "=" : BASE64[c & 63];
  }
  return output;
}

class BlobFileReader {
  result: string | ArrayBuffer | null = null;
  onloadend: (() => void) | null = null;

  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((result) => {
      this.result = result;
      queueMicrotask(() => this.onloadend?.());
    });
  }

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((result) => {
      this.result =
        `data:${blob.type || "application/octet-stream"};base64,${base64(new Uint8Array(result))}`;
      queueMicrotask(() => this.onloadend?.());
    });
  }
}

export async function toGLTF(
  scene: THREE.Object3D,
  opts: { binary?: boolean } = {},
): Promise<ArrayBuffer | object> {
  if (typeof FileReader !== "undefined") {
    return new GLTFExporter().parseAsync(scene, { binary: opts.binary });
  }
  const runtime = globalThis as typeof globalThis & {
    FileReader?: typeof FileReader;
  };
  runtime.FileReader = BlobFileReader as unknown as typeof FileReader;
  try {
    return await new GLTFExporter().parseAsync(scene, {
      binary: opts.binary,
    });
  } finally {
    if (runtime.FileReader === BlobFileReader) {
      Reflect.deleteProperty(runtime, "FileReader");
    }
  }
}

export function toOBJ(scene: THREE.Object3D): string {
  return new OBJExporter().parse(scene);
}

export function toSTL(
  scene: THREE.Object3D,
  opts: { binary?: boolean } = {},
): ArrayBuffer | string {
  const result = new STLExporter().parse(scene, { binary: opts.binary });
  return typeof result === "string" ? result : result.buffer;
}
