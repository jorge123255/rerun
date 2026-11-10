/*
 * Inert fake Claude CLI for the bundled-runner fixture (bundled-runner.test.ts).
 *
 * It speaks a tiny line protocol over stdin/stdout and never execs, forks, writes files or
 * touches the network, so it runs under the production claude-runner sandbox policy, which
 * limits process-exec to the bundled binary literal and writes to the per-run profile.
 *
 * Lines it understands:
 *   ping      -> {"revision":"..","tokenBytes":N,"tokenSum":N,"hasToken":0|1,"ambient":0|1}
 *   echo      -> the raw CLAUDE_CODE_OAUTH_TOKEN on stdout (redaction probe)
 *   echo-b64  -> base64 of the token on stdout (redaction probe)
 *   echo-hex  -> hex of the token on stdout (redaction probe)
 *   echo-stderr -> the raw token on stderr (diagnostic-pipe redaction probe)
 *   quit      -> exit 0
 *
 * The probe reports the exact credential generation the child received (token length and byte
 * sum plus the fixture revision) without echoing the token, so the test can assert the reopened
 * generation reached exactly one confined child while the bound output filter proves redaction.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char BASE64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static unsigned long token_sum(const char *token) {
    unsigned long sum = 0;
    const unsigned char *p = (const unsigned char *)token;
    while (*p) { sum = (sum + *p) & 0xffffffffUL; p++; }
    return sum;
}

static int has_ambient(void) {
    return (getenv("ANTHROPIC_API_KEY") || getenv("NODE_OPTIONS") || getenv("HTTPS_PROXY")) ? 1 : 0;
}

static void print_b64(const char *token) {
    size_t n = strlen(token), i = 0;
    while (i + 3 <= n) {
        unsigned v = ((unsigned char)token[i] << 16) | ((unsigned char)token[i + 1] << 8) | (unsigned char)token[i + 2];
        putchar(BASE64[(v >> 18) & 63]); putchar(BASE64[(v >> 12) & 63]); putchar(BASE64[(v >> 6) & 63]); putchar(BASE64[v & 63]);
        i += 3;
    }
    if (i + 1 == n) {
        unsigned v = (unsigned char)token[i] << 16;
        putchar(BASE64[(v >> 18) & 63]); putchar(BASE64[(v >> 12) & 63]); putchar('='); putchar('=');
    } else if (i + 2 == n) {
        unsigned v = ((unsigned char)token[i] << 16) | ((unsigned char)token[i + 1] << 8);
        putchar(BASE64[(v >> 18) & 63]); putchar(BASE64[(v >> 12) & 63]); putchar(BASE64[(v >> 6) & 63]); putchar('=');
    }
    putchar('\n');
}

int main(void) {
    char line[4096];
    while (fgets(line, sizeof(line), stdin)) {
        size_t len = strlen(line);
        while (len && (line[len - 1] == '\n' || line[len - 1] == '\r')) line[--len] = '\0';
        const char *token = getenv("CLAUDE_CODE_OAUTH_TOKEN");
        if (!token) token = "";
        const char *revision = getenv("RERUN_CLAUDE_CREDENTIAL_REVISION");
        if (!revision) revision = "";
        if (strcmp(line, "ping") == 0) {
            printf("{\"revision\":\"%s\",\"tokenBytes\":%zu,\"tokenSum\":%lu,\"hasToken\":%d,\"ambient\":%d}\n",
                revision, strlen(token), token_sum(token), strlen(token) ? 1 : 0, has_ambient());
        } else if (strcmp(line, "echo") == 0) {
            printf("%s\n", token);
        } else if (strcmp(line, "echo-b64") == 0) {
            print_b64(token);
        } else if (strcmp(line, "echo-hex") == 0) {
            size_t i;
            for (i = 0; i < strlen(token); i++) printf("%02x", (unsigned char)token[i]);
            putchar('\n');
        } else if (strcmp(line, "echo-stderr") == 0) {
            fprintf(stderr, "%s\n", token);
        } else if (strcmp(line, "quit") == 0) {
            fflush(stdout);
            return 0;
        }
        fflush(stdout);
    }
    return 0;
}
