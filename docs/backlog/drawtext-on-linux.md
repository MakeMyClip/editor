# drawtext on Linux

Text tools now stop with `MissingFilterError` instead of FFmpeg's "No such filter", but text still doesn't render with the default Linux install. `ffmpeg-static` 5.3.0 downloads John Van Sickle's FFmpeg 7.0.2 build, which has libfreetype but not libharfbuzz, and drawtext needs both since FFmpeg 6.1 (upstream issue eugeneware/ffmpeg-static#147; the fix in #158 is unmerged). Decided 2026-10-29: keep `ffmpeg-static` and the fail-fast error, and don't swap the binary source for now. Revisit when `ffmpeg-static` ships a Linux build with drawtext.
