# Cut words at the pause

`cut_words` and `remove_retakes` cut from the first word's start to the last word's end as whisper.cpp gives them (`planWordCut` in `src/timeline/transcript.ts`). whisper gives each pause to the word before it and runs late at sentence edges. On a 30-sentence test recording, cutting a sentence would also remove up to 0.35 s of the next sentence's first syllable, at 18 of 29 boundaries. Place those cut edges in the pause the audio shows, as `make_short` does (`src/timeline/pauses.ts`), through `VerbContext.speechLevels`.
