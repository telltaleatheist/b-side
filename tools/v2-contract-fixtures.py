"""Render the v2 call contract (orpheus-finetune pipeline/lyrics/v2/tasks.py) for fixed cases, so
test/album-text.test.ts can hold B-Sides' TypeScript to it byte for byte.

    python tools/v2-contract-fixtures.py [path/to/orpheus-finetune] > test/fixtures/v2-contract.json

Re-run whenever tasks.py changes; the fixture is what the model was trained on.
"""
import json
import os
import sys

root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', 'orpheus-finetune')
sys.path.insert(0, os.path.join(root, 'pipeline', 'lyrics', 'v2'))
import tasks as T  # noqa: E402

page = T.load_page()
album = {"title": "Spotted at the Edges", "artist": "The Fruit Bowl Elegies",
         "blurb": "A slow, sweet record about ripening and letting go.", "coverPrompt": "a banana on a windowsill",
         "core": "indie folk, melancholic, fingerpicked acoustic guitar, upright bass, soft brushed drums"}
tempo_core = "synthwave, nostalgic, analog synth bass, gated reverb drums, 104 BPM"
asks = {
    "sung_desc_brief": {"description": "sad songs about bananas", "tags": [], "sung": True, "lyrics": "a banana left on the counter too long"},
    "sung_tags_tempo": {"description": "", "tags": tempo_core.split(", "), "sung": True, "lyrics": ""},
    "instr_desc_tags": {"description": "driving at night through a rainy city", "tags": ["synthwave", "nostalgic"], "sung": False, "lyrics": ""},
    "instr_nothing": {"description": "", "tags": [], "sung": False, "lyrics": "a brief that an instrumental album ignores"},
}
cases = []
for name, ask in asks.items():
    for count in (15, 45):
        core = ", ".join(ask["tags"]) if ask["tags"] else album["core"]
        alb = dict(album, core=core)
        titles = [f"Track {i}" for i in range(1, count + 1)]
        about = ask["description"].strip() or ", ".join(ask["tags"]) or "(none)"
        case = {
            "id": f"{name}_{count}", "ask": ask, "count": count, "album": alb,
            "albumPrompt": T.album_prompt(ask, count, page),
            "albumUser": T.plan_user(ask),
            "batches": T.batches(count),
            "tracks": [{"first": a, "last": b,
                        "prompt": T.tracks_prompt(ask["sung"], core, a, b, count, page),
                        "user": T.tracks_user(ask, alb, titles[:a - 1]),
                        "schema": T.schema_tracks(b - a + 1)} for a, b in T.batches(count)],
            "lyricsUser": T.lyrics_user(alb, "Counter Light", T.track_tags(core, "soft female voice, 68 BPM", ask["sung"]), about,
                                        ask["lyrics"] if ask["sung"] else ""),
            "trackTags": T.track_tags(core, "soft female voice, 68 BPM", ask["sung"]),
            "titleUser": T.title_user(ask, alb, ["Spotted at the Edges"]),
            "titleUserNoAvoid": T.title_user(ask, alb),
            "artistUser": T.artist_user(ask, alb),
            "artistUserAvoid": T.artist_user(ask, alb, ["The Fruit Bowl Elegies"]),
            "titlesUser": T.titles_user(ask, alb, 5, ["Track 1", "Track 2"]),
            "coverUser": T.cover_user(ask, alb),
        }
        cases.append(case)

json.dump({
    "page": page,
    "lyricsPrompt": T.lyrics_prompt(),
    "titlePrompt": T.title_prompt(),
    "artistPrompt": T.artist_prompt(),
    "titlesPrompt5": T.titles_prompt(5),
    "coverPrompt": T.cover_prompt(),
    "schemas": {"album": T.ALBUM_SCHEMA, "lyrics": T.LYRICS_SCHEMA, "title": T.schema_one("title"), "titles5": T.schema_titles(5)},
    "describe": {"tagPrompt": T.tag_prompt(page, False), "tagPromptInstr": T.tag_prompt(page, True),
                 "user": T.describe_user("smooth lo fi with jazz sax", "a banana going brown"),
                 "userInstr": T.describe_user("smooth lo fi with jazz sax", "a banana going brown", True),
                 "schema": T.SONG_TAGS_SCHEMA},
    "cases": cases,
}, sys.stdout, indent=1, ensure_ascii=False)
