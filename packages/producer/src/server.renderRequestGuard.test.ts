import { Hono } from "hono";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capturedRenderConfigs = vi.hoisted(() => new Array<Record<string, unknown>>());
const capturedExecuteOutputPaths = vi.hoisted(() => new Array<string>());

vi.mock("./services/renderOrchestrator.js", () => {
  class RenderCancelledError extends Error {}

  return {
    RenderCancelledError,
    createRenderJob: (config: Record<string, unknown>) => {
      capturedRenderConfigs.push(config);
      return {
        config,
        progress: 0,
        currentStage: "queued",
        framesRendered: 0,
        totalFrames: 0,
        warnings: [],
      };
    },
    executeRenderJob: async (
      job: Record<string, unknown>,
      _projectDir: string,
      outputPath: string,
    ) => {
      capturedExecuteOutputPaths.push(outputPath);
      job.outcome = "completed";
      job.currentStage = "complete";
    },
  };
});

import { createRenderHandlers, validatePreviewUrl } from "./server.js";

let sandbox = "";
let rendersDir = "";

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "producer-guard-"));
  rendersDir = join(sandbox, "renders");
  capturedRenderConfigs.splice(0);
  capturedExecuteOutputPaths.splice(0);
});

afterEach(() => {
  delete process.env.PRODUCER_PREVIEW_HOST_ALLOWLIST;
  rmSync(sandbox, { recursive: true, force: true });
});

function createApp(): Hono {
  const app = new Hono();
  const handlers = createRenderHandlers({
    getRequestId: () => "guard-test",
    maxConcurrentRenders: 1,
    rendersDir,
  });
  app.post("/render", handlers.render);
  app.post("/render/stream", handlers.renderStream);
  return app;
}

function requestStream(overrides: Record<string, unknown>) {
  return createApp().request("/render/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ html: "<html><body></body></html>", ...overrides }),
  });
}

describe("POST /render — outputPath containment", () => {
  it("rejects an outputPath that escapes the renders directory", async () => {
    const escaped = join(sandbox, "outside", "evil.mp4");
    const response = await createApp().request("/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html: "<html><body></body></html>", outputPath: escaped }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("renders directory");
    expect(capturedRenderConfigs).toHaveLength(0);
    expect(existsSync(join(sandbox, "outside"))).toBe(false);
  });

  it("rejects a traversal outputPath that resolves outside the renders directory", async () => {
    const response = await requestStream({
      outputPath: join(rendersDir, "..", "outside", "evil.mp4"),
    });

    expect(response.status).toBe(200); // SSE envelope
    const text = await response.text();
    expect(text).toContain('"type":"error"');
    expect(text).toContain("renders directory");
    expect(capturedRenderConfigs).toHaveLength(0);
    expect(existsSync(join(sandbox, "outside"))).toBe(false);
  });

  it("rejects the legacy `output` alias with the same containment", async () => {
    const response = await createApp().request("/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html: "<html><body></body></html>", output: "C:\\evil\\x.mp4" }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("renders directory");
    expect(capturedRenderConfigs).toHaveLength(0);
  });

  it("accepts a bare filename and renders inside the renders directory", async () => {
    const response = await requestStream({ outputPath: "out.mp4" });

    expect(await response.text()).toContain('"type":"complete"');
    expect(capturedRenderConfigs).toHaveLength(1);
    const outputPath = capturedExecuteOutputPaths[0];
    expect(typeof outputPath).toBe("string");
    expect(outputPath?.startsWith(rendersDir)).toBe(true);
  });

  it("accepts an outputPath nested inside the renders directory", async () => {
    const response = await requestStream({ outputPath: join(rendersDir, "sub", "out.mp4") });

    expect(await response.text()).toContain('"type":"complete"');
    expect(capturedRenderConfigs).toHaveLength(1);
  });

  it("still renders when no outputPath is supplied", async () => {
    const response = await requestStream({});

    expect(await response.text()).toContain('"type":"complete"');
    expect(capturedRenderConfigs).toHaveLength(1);
  });
});

describe("previewUrl guard", () => {
  it("allows loopback http and https URLs", () => {
    expect(validatePreviewUrl("http://127.0.0.1:4173/")).toBeUndefined();
    expect(validatePreviewUrl("http://localhost:4173/index.html")).toBeUndefined();
    expect(validatePreviewUrl("https://localhost/")).toBeUndefined();
    expect(validatePreviewUrl("http://[::1]:4173/")).toBeUndefined();
  });

  it("rejects non-http schemes", () => {
    expect(validatePreviewUrl("file:///etc/passwd")).toContain("http or https");
    expect(validatePreviewUrl("ftp://127.0.0.1/x")).toContain("http or https");
  });

  it("rejects malformed URLs", () => {
    expect(validatePreviewUrl("not a url")).toContain("valid URL");
  });

  it("rejects non-loopback hosts", () => {
    expect(validatePreviewUrl("http://192.168.1.5:8080/")).toContain("loopback");
    expect(validatePreviewUrl("https://example.com/")).toContain("loopback");
    expect(validatePreviewUrl("http://169.254.169.254/latest/meta-data")).toContain("loopback");
  });

  it("honors the PRODUCER_PREVIEW_HOST_ALLOWLIST override", () => {
    process.env.PRODUCER_PREVIEW_HOST_ALLOWLIST = "Staging.Example.com";
    expect(validatePreviewUrl("https://staging.example.com:8443/")).toBeUndefined();
    expect(validatePreviewUrl("https://other.example.com/")).toContain("loopback");
  });

  it("rejects a non-loopback previewUrl at the handler level", async () => {
    const response = await createApp().request("/render/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // No `html` field: resolveInlineRenderHtml short-circuits html before it
      // ever considers previewUrl, so the guard must be tested without it.
      body: JSON.stringify({ previewUrl: "http://192.168.1.5:8080/" }),
    });

    const text = await response.text();
    expect(text).toContain('"type":"error"');
    expect(text).toContain("loopback");
    expect(capturedRenderConfigs).toHaveLength(0);
  });

  it("lets a loopback previewUrl pass validation and reach the fetch stage", async () => {
    const response = await createApp().request("/render/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ previewUrl: "http://127.0.0.1:1/index.html" }),
    });

    const text = await response.text();
    // Guard passed (no "loopback" complaint); the fetch itself fails fast on a
    // refused loopback port, proving the request proceeded past validation.
    expect(text).not.toContain("loopback");
    expect(text).toContain("Failed to fetch previewUrl");
  });
});
