# Dobre vijesti

Pulls headlines from Bosnian news portals (Klix, Avaz, N1, Radiosarajevo),
scores each one with a Bosnian positive/negative word lexicon, and shows only
the positive stories. A positivity gauge reports what share of all fetched news
is actually positive versus neutral or negative.

The sentiment score is a keyword heuristic, not a language model — it is an
approximation, so an occasional story will be mislabeled.
