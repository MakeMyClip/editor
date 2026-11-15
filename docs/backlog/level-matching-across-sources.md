# Level matching across sources

`clip timeline loudness` normalizes the whole exported mp4 to one integrated loudness, so a timeline that joins a quiet recording and a loud one keeps the jump between them. Measure each media clip's loudness and add a per-clip `volume` effect that brings them to a common level before the program-level pass.
