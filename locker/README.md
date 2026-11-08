# Blasta Bank Locker

This is a private, password-protected home for your own `.sf2` / `.op2` banks. It's a Cloudflare Worker in front of an R2 bucket. Once you unlock it in Blasta:

- any bank you load into a slot is uploaded, and the slot assignment is saved;
- any other device or browser gets the same banks just by unlocking. Each device keeps a cached copy, so a bank downloads only once per device unless it changes.

Every request (listing, upload, download, delete) needs the password. The password exists only as an encrypted Worker secret, and the bucket is never public. The Worker only accepts calls from the sites listed in `ALLOWED_ORIGINS`.

## Sharing with visitors (read-only)

Everything in the locker is private until you share it:

- **Public** checkbox on a bank: anyone who opens Blasta sees it on the *Public banks* shelf and can load it into their own slots. They can't change, delete or replace it.
- **Publish my slots as site default**: the banks currently in your slots become what every visitor hears by default, instead of the built-in banks. Publishing makes those banks public, and the confirmation dialog lists exactly which ones.

Visitors can always load their own `.sf2` / `.op2` files. Those stay in their own browser and are never uploaded. Only an unlocked locker uploads anything.

What each device gets per slot, in order of priority:

1. On a device where you've unlocked, your own locker assignment.
2. That browser's own choice.
3. Your published site default.
4. The built-in banks.

Only share banks you made or that are freely licensed. A public bank can be downloaded by anyone.

## One-time setup

From this folder, logged in to your Cloudflare account:

```sh
npx wrangler login                          # opens a browser to authorise
npx wrangler r2 bucket create blasta-banks  # the private bucket
npx wrangler secret put LOCKER_PASSWORD     # type a long password when prompted
npx wrangler deploy                         # prints https://blasta-locker.<you>.workers.dev
```

Then in Blasta, open **Bank Locker**, paste that URL, enter the password and click **Unlock**.

If you serve Blasta from somewhere other than `https://samuelling.github.io`, add that origin to `ALLOWED_ORIGINS` in `wrangler.toml` and run `npx wrangler deploy` again. To change the password, run `npx wrangler secret put LOCKER_PASSWORD` again; devices then need to unlock with the new one.

## Limits and costs

- One upload can be at most **100 MB**, which is Cloudflare's request-body limit. Bigger banks stay on the device where you loaded them.
- R2 storage is about $0.015/GB-month beyond the free 10 GB, and there are no download (egress) fees. A shelf of soundfonts costs effectively nothing.
- If you tick "Remember on this device", the password is kept in that browser's localStorage. Leave it unticked on shared machines, and it's then forgotten when the tab closes.
