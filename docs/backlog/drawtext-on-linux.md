# drawtext on Linux

Text tools now stop with `MissingFilterError` instead of FFmpeg's "No such filter", but text still doesn't render with the default Linux install. `ffmpeg-static` 5.3.0 downloads John Van Sickle's FFmpeg 7.0.2 build, which has libfreetype but not libharfbuzz, and drawtext needs both since FFmpeg 6.1 (upstream issue eugeneware/ffmpeg-static#147; the fix in #158 is unmerged). Still open: switch the Linux binary source to a build with harfbuzz (for example BtbN FFmpeg-Builds), or keep requiring `MAKEMYCLIP_FFMPEG_PATH`.
