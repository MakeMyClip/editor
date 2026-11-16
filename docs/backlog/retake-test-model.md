# Retake integration test depends on the model

`tests/integration/timeline-transcript.test.ts` ("removes a repeated take as one undoable edit") runs whenever whisper.cpp and a model are set up. With `ggml-base.en.bin` it fails on `feat/shorts` too: the model's transcript of the test's spoken phrase has no immediate repeat, so `retakes` is empty. Make the test independent of the model (assert on a stored transcript with a known repeat, as the unit tests do) or pin the model it was written for.
