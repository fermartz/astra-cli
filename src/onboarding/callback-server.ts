import { createServer } from "node:http";

const CALLBACK_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

/**
 * Start a temporary localhost HTTP server to capture the OAuth callback.
 *
 * Security:
 * - Binds to 127.0.0.1 only (never 0.0.0.0)
 * - Validates state parameter (CSRF protection)
 * - Auto-closes after receiving callback or timeout
 */
export async function waitForCallback(params: {
  redirectUri: string;
  expectedState: string;
  timeoutMs?: number;
  onListening?: () => void;
}): Promise<{ code: string; state: string }> {
  const redirectUrl = new URL(params.redirectUri);
  const hostname = redirectUrl.hostname || "127.0.0.1";
  const port = redirectUrl.port ? Number.parseInt(redirectUrl.port, 10) : 80;
  const expectedPath = redirectUrl.pathname || "/";
  const timeoutMs = params.timeoutMs ?? CALLBACK_TIMEOUT_MS;

  // Security: only allow loopback binding
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
    throw new Error(
      `OAuth callback must bind to loopback (got ${hostname}). Use http://127.0.0.1:<port>/...`,
    );
  }

  return new Promise<{ code: string; state: string }>((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;

    const server = createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url ?? "/", redirectUrl.origin);

        if (requestUrl.pathname !== expectedPath) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not found");
          return;
        }

        const code = requestUrl.searchParams.get("code")?.trim();
        const state = requestUrl.searchParams.get("state")?.trim();

        if (!code) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Missing authorization code");
          return;
        }

        if (!state || state !== params.expectedState) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Invalid state parameter");
          return;
        }

        // Success — show confirmation page
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(
          [
            "<!doctype html>",
            "<html><head><meta charset='utf-8'><title>AstraNova</title></head>",
            "<body style='font-family:system-ui;text-align:center;padding:40px'>",
            "<h2>Login complete</h2>",
            "<p>You can close this window and return to AstraNova CLI.</p>",
            "</body></html>",
          ].join(""),
        );

        if (timeout) clearTimeout(timeout);
        server.close();
        resolve({ code, state });
      } catch (err) {
        if (timeout) clearTimeout(timeout);
        server.close();
        reject(err);
      }
    });

    server.once("error", (err) => {
      if (timeout) clearTimeout(timeout);
      server.close();
      reject(err);
    });

    server.listen(port, hostname, () => {
      params.onListening?.();
    });

    timeout = setTimeout(() => {
      try {
        server.close();
      } catch {
        // Ignore close errors during timeout cleanup
      }
      reject(new Error("OAuth callback timeout — no response received within 3 minutes."));
    }, timeoutMs);
  });
}
