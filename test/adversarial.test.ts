import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { decode, decodeHeic, parseIpma, parseHvcC, splitLengthPrefixed } from "../src";
const sample = new Uint8Array(
  readFileSync(new URL("./fixtures/conformance/pattern-10.heic", import.meta.url)),
);
for (let round = 1; round <= 20; round++)
  describe(`adversarial round ${round}`, () => {
    it("rejects forged association count before iterating beyond bytes", () => {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setUint32(4, 1000 * round);
      expect(() => parseIpma(bytes)).toThrow();
    });
    it("rejects truncated decoder configuration", () => {
      expect(() => parseHvcC(new Uint8Array(round))).toThrow();
    });
    it("rejects a truncated trailing NAL instead of silently discarding it", () => {
      const bytes = new Uint8Array([0, 0, 0, 2, 38, 1, 0, 0, 0, round + 2, 38]);
      expect(() => splitLengthPrefixed(bytes, 4)).toThrow();
    });
    it("rejects zero-length prefix size instead of accepting a partial stream", () => {
      expect(() => splitLengthPrefixed(new Uint8Array([1, 2]), 0)).toThrow();
    });
    it("preserves falsy in-flight abort reasons and terminates its worker", async () => {
      const controller = new AbortController();
      let terminated = 0;
      const reason = [0, false, "", null, undefined][(round - 1) % 5];
      const worker = {
        postMessage() {},
        terminate() {
          terminated++;
        },
      } as unknown as Worker;
      const promise = decode(sample, { signal: controller.signal, workerFactory: () => worker });
      controller.abort(reason);
      let rejected = false;
      try {
        await promise;
      } catch (error) {
        rejected = true;
        expect(error).toBe(controller.signal.reason);
      }
      expect(rejected).toBe(true);
      expect(terminated).toBe(1);
    });
    it("rejects huge input before creating a worker/copying its buffer", async () => {
      let created = 0;
      await expect(
        decode(new Uint8Array(64 * 1024 * 1024 + round), {
          workerFactory() {
            created++;
            throw Error("worker must not be created");
          },
        }),
      ).rejects.toThrow("64 MiB");
      expect(created).toBe(0);
    });
    it("rejects timer overflow and malformed worker images without leaking workers", async () => {
      let created = 0;
      await expect(
        decode(sample, {
          timeoutMs: 2147483648,
          workerFactory() {
            created++;
            throw Error("must not create");
          },
        }),
      ).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
      expect(created).toBe(0);
      let terminated = 0;
      const worker = {
        postMessage() {
          queueMicrotask(() =>
            worker.onmessage?.({
              data: { image: { width: 64, height: 64, bitDepth: 8, data: new Uint8Array(1) } },
            } as MessageEvent),
          );
        },
        terminate() {
          terminated++;
        },
        onmessage: null,
      } as unknown as Worker;
      await expect(decode(sample, { workerFactory: () => worker })).rejects.toMatchObject({
        code: "WORKER_FAILED",
      });
      expect(terminated).toBe(1);
    });
    it("normalizes failed Blob reads and rejects nonnumeric pixel limits before dispatch", async () => {
      class BrokenBlob extends Blob {
        async arrayBuffer(): Promise<ArrayBuffer> {
          throw Error("read failed");
        }
      }
      await expect(decode(new BrokenBlob())).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(decode(sample, { maxPixels: NaN })).rejects.toMatchObject({
        code: "INVALID_OPTIONS",
      });
    });
    it("enforces pixel boundary consistently on the main thread", async () => {
      expect(() => decodeHeic(sample, { maxPixels: 4095 })).toThrow("maxPixels");
      expect(decodeHeic(sample, { maxPixels: 4096 }).width).toBe(64);
      await expect(decode(sample, { execution: "main", maxPixels: 0 })).rejects.toThrow(
        "maxPixels",
      );
    });
  });
