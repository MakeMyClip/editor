# Segment duration rounding

Export renders each clip as its own segment and joins them, and each segment comes out a little longer than its clip: the video rounds up to a whole frame and the AAC audio to a whole 1024-sample frame. A three-piece short planned at 16.200 s exported as 488 video frames (16.267 s at 30 fps) and 16.25 s of audio. Check whether the audio-video offset accumulates over a timeline with hundreds of cuts (a silence-cut hour), and if it does, trim each segment to a frame-aligned length or carry the remainder into the next segment.
