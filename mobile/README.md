# OfficeAI Remote

Flutter companion app for the read-only OfficeAI tunnel.

## Run

Install Flutter, generate the native platform folders once, then:

```bash
flutter create --platforms=android,ios .
flutter pub get
flutter run
```

In the desktop OfficeAI app, open **Remote**, tap **Buka tunnel**, then copy the
displayed URL and token into this app. The app polls `/api/agents` and
`/api/stats` every two seconds.

The API is intentionally read-only. The Cloudflare URL and bearer token are
credentials: share them only with the device that should see the workspace.
