# Clip inspector has no room on a short window

In `clip ui`, the viewer takes up to 44vh plus its bar, and the clip inspector (`.stage-detail`) gets whatever is left of `.main`. At a 1000 px tall window, `.main` is 468 px and the viewer fills all of it, so the inspector is 0 px tall: a selected clip's transcript, framing and Make short can't be reached. It works at 1500 px. Seen on 2026-11-15 while checking the shorts tabs; the layout was the same before them, and the tabs bar takes another ~30 px once a short exists.

Fix: give the inspector a minimum height (or let the viewer shrink first), and check at 900 px tall.
