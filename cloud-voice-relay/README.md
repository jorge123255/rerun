# Rerun voice relay

A small Cloudflare Worker that lets a paired phone hold a spoken conversation with the Chief of Staff
on your Mac, through ElevenLabs Speech Engine, while the Mac accepts nothing from the internet.

```
phone ──(audio, WebRTC)──▶ ElevenLabs ──(text, WebSocket)──▶ this relay ◀──(text, WebSocket)── your Mac
```

- The phone exchanges audio with ElevenLabs, using a short-lived conversation token the Mac mints.
- ElevenLabs turns speech into text and opens a WebSocket to this relay to send it.
- Your Mac keeps one outbound WebSocket to this relay, answers with Chief of Staff turns as text, and
  ElevenLabs speaks them.

You deploy it on your own Cloudflare account, on a `workers.dev` address or a subdomain of your own.
Nothing here is shared with anyone else's Mac.

## What each side can see

| | sees | never sees |
|---|---|---|
| The relay | the text of a conversation while it passes through; ElevenLabs' signed connection token; which install id is used | your ElevenLabs key or its hash; your relay secret after deploy (Cloudflare holds it as a secret); anything stored: it keeps no text |
| ElevenLabs | the phone's audio; the text of both sides; your engine settings | your Mac's address; the relay secret |
| Your Mac | everything in the conversation; it checks every connection | — |

- **The Mac authenticates to the relay** with a secret only that Mac and the relay hold: every
  connection carries `X-Rerun-Relay-Auth: v1.<time>.<nonce>.<HMAC-SHA256>` over the install id,
  host, path, time and nonce. The relay accepts it within 30 seconds of the Mac's clock and only once
  per nonce, and compares in constant time.
- **ElevenLabs authenticates to the Mac**, not to the relay: the relay requires ElevenLabs' header
  `X-Elevenlabs-Speech-Engine-Authorization` and hands it to the Mac untouched. The Mac checks it
  (HS256, keyed by the SHA-256 of its ElevenLabs key, issuer, subject, expiry, 60 s leeway). The relay
  cannot: it never holds the key or its hash.
- **Only conversations the Mac started get through.** Before a phone gets its token, the Mac announces
  that conversation's id to the relay. An ElevenLabs connection whose `init` names any other id is
  closed, and each announced id opens one connection, once. The Mac checks the same again.
- No Mac connected: ElevenLabs is refused (503). At most two conversations at once per install, small
  frame size and rate limits, idle connections closed. The relay logs nothing.
- Optional: admit ElevenLabs only from its published egress addresses (`ELEVENLABS_EGRESS_CHECK`, off
  by default; the list is in `wrangler.example.toml`).

## Deploy

You need a Cloudflare account (the free plan runs Durable Objects with SQLite storage) and Node 22.18 or
later. Nothing in this folder holds an account id, zone or hostname; they live only in your own copy.

1. Make your config and deploy:
   ```sh
   cd cloud-voice-relay
   cp wrangler.example.toml wrangler.toml   # git ignores wrangler.toml
   # Optional, for your own subdomain: uncomment [[routes]] in wrangler.toml and set the pattern,
   # e.g. voice.your-domain.example (the domain must be on your Cloudflare account).
   npx wrangler login
   npx wrangler deploy
   ```
   Note the address it prints (`https://rerun-voice-relay.<you>.workers.dev`, or your subdomain).
   Until step 3 every path answers 404.
2. On the Mac: **Settings → Tool services → Talk to the Chief of Staff from your phone**. Enter the
   address, **Save address**. The Mac shows its relay values once.
3. Give the relay this Mac's value:
   ```sh
   npx wrangler secret put RELAY_INSTALLS
   # paste the "RELAY_INSTALLS value" the Mac shows: {"<install id>":"<secret>"}
   ```
   Several Macs or workspaces can share one relay: put their entries in one JSON object.
4. On the Mac, with an ElevenLabs key saved under Tool services: **Create voice engine**. It makes a
   Speech Engine in your ElevenLabs account that needs a token from your Mac to start, does not record
   audio, keeps transcripts as briefly as ElevenLabs allows, ends calls after ten minutes, and speaks in
   the voice chosen under "Replies read aloud".
5. Turn on **Allow voice conversations from paired phones**. The status should read **Relay connected**.
6. On the Mac's phone list, a phone needs **Send messages** to start a voice conversation.

New values (if the secret may have leaked): **Make new relay values**, repeat step 3 with the new
value, then **Create voice engine** again. **Remove** forgets everything on the Mac; delete the engine
in your ElevenLabs account and the Worker in Cloudflare yourself.

## Check it locally

```sh
node --test test/*.test.ts      # no install needed
npx tsc -p tsconfig.json        # after npm install
```

The tests run the Worker and its Durable Object under a Node stand-in for the Workers runtime
(`test/fake-runtime.ts`), including hibernation between frames.
