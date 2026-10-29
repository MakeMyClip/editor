# drawtext on Linux

The Linux `ffmpeg-static` 5.3.0 binary is built without libfreetype, so it has no `drawtext` filter (CI: "No such filter: 'drawtext'"). `add_text`, `add_captions`, `add_title_card` and timeline text clips fail on Linux unless `$MAKEMYCLIP_FFMPEG_PATH` points at an FFmpeg that has it; detect that up front with an actionable error, or bundle a build that includes drawtext.
