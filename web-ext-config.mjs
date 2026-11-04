export default {
  // Everything the extension needs at runtime is listed here; the rest is repo
  // tooling and docs, which web-ext lint would otherwise flag.
  ignoreFiles: [
    "dist/**",
    "scripts/**",
    "README.md",
    "PRIVACY_POLICY.md",
    "LICENSE",
    "screenshot.jpg",
    ".gitignore"
  ]
}
