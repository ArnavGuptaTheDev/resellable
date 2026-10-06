#!/usr/bin/env node
// Generates a VAPID key pair for Web Push.
//   node scripts/vapid.mjs            prints both (for your local .dev.vars)
//   node scripts/vapid.mjs --public   prints only the public key
//   node scripts/vapid.mjs --private  prints only the private key (pipe into `wrangler secret put VAPID_PRIVATE_KEY`)
// Generate once per environment; changing keys invalidates existing subscriptions.
import { createECDH } from 'node:crypto';

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
const pub = ecdh.getPublicKey('base64url'); // uncompressed 65 bytes
const priv = ecdh.getPrivateKey().toString('base64url').padStart(43, 'A');

const arg = process.argv[2];
if (arg === '--public') process.stdout.write(pub);
else if (arg === '--private') process.stdout.write(priv);
else console.log(`VAPID_PUBLIC_KEY=${pub}\nVAPID_PRIVATE_KEY=${priv}`);
