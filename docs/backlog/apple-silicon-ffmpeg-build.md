# Redistributable FFmpeg for Apple Silicon

`ffmpeg-static`'s darwin-arm64 binary (FFmpeg 6.0 from osxexperts) is built with `--enable-nonfree`, and `ffmpeg -L` says it is not legally redistributable. npm installs on Apple Silicon download it, and the Claude Desktop extension ships no FFmpeg because of it. Find or build a GPL arm64 FFmpeg with drawtext and vidstab (a pinned CI build from source, with its corresponding source published) so Apple Silicon users get a redistributable build, and so the `.mcpb` could include FFmpeg for one-click setup.
