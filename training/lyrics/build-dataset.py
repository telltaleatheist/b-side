"""
build-dataset: the B-Side lyrics fine-tune set, from the raw chunks Haiku wrote.

    python3 training/lyrics/build-dataset.py RAW_DIR SYSTEM_DIR OUT.jsonl

RAW_DIR holds chunk-NNN.jsonl files ({"id","genre","description","answer"}).
SYSTEM_DIR holds system-sung.txt and system-instrumental.txt: B-Side's exact
describe prompts (tagPrompt(page, false|true)) built from a real song page, so
training prompts match what the model sees when B-Side calls it.

Every example is checked; one that fails any check is dropped (and counted by
reason), never repaired into something it was not:
  - the answer is the describe() JSON, every field the right type and range;
  - instrumental: vocal is [] and lyrics is "";
  - sung: [verse] [chorus] [verse] [chorus], four lines each, the chorus
    repeated word for word, every line 5-11 syllables (the brief asks 6-9;
    the counter is a heuristic), no banned cliche; four different lines in
    each verse and at least three in the chorus (a hook may repeat; two lines
    sung twice may not), the two verses different; no religious words;
  - no repeated request, no repeated chorus.
Instrumental answers are split between the two prompts B-Side sends: the
instrumental switch on (system-instrumental.txt) or a request that asks for no
vocals (system-sung.txt).

Each line of OUT.jsonl, as agreed with the training session:
  {id, genre, description, instrumental_requested, system, answer, messages, title}
"""
import json
import os
import random
import re
import sys
from collections import Counter

RAW, SYSTEMS, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
SYSTEM_SUNG = open(os.path.join(SYSTEMS, 'system-sung.txt')).read()
SYSTEM_INSTRUMENTAL = open(os.path.join(SYSTEMS, 'system-instrumental.txt')).read()
random.seed(7)

KEYS = ['language', 'genre', 'mood', 'vocal', 'instruments', 'sound', 'bpm', 'instrumental', 'lyrics']
LIMITS = {'genre': (1, 3), 'mood': (1, 3), 'vocal': (0, 2), 'instruments': (1, 5), 'sound': (0, 3)}
CLICHES = [
    'heart of gold', 'dancing in the rain', 'set me free', 'fire in my soul', 'shine so bright',
    'end of time', 'meant to be', 'touch the sky', 'lost without you', 'break these chains',
    'lost in your eyes', 'meant to see',
]
# Lyrics stay secular (Owen's standing rule), gospel included: its sound, not its words.
RELIGIOUS = re.compile(r'\b(god|lord|jesus|pray|prayers?|praying|church|heaven|amen|holy|gospel|angels?|bible|hallelujah|savior|saviour)\b')
SECTIONS = ['[verse]', '[chorus]', '[verse]', '[chorus]']


def syllables(line: str) -> int:
    """A rough English syllable count: vowel groups per word, a silent final e dropped."""
    total = 0
    for word in re.findall(r"[a-zA-Z']+", line.lower()):
        groups = re.findall(r'[aeiouy]+', word)
        n = len(groups)
        if word.endswith('e') and not word.endswith(('le', 'ee')) and n > 1:
            n -= 1
        total += max(1, n)
    return total


def lay(raw: str) -> list[str]:
    """The lyrics as lines, section tags on their own lines (as B-Side's layLyrics does)."""
    text = re.sub(r' {2,}', '\n', raw.replace('\r', ''))
    text = re.sub(r'\s*(\[(?:verse|chorus|bridge|outro|intro)[^\]]*\])\s*', r'\n\1\n', text, flags=re.I)
    return [line.strip() for line in text.split('\n') if line.strip() != '']


def check(answer) -> str | None:
    """Why this answer is not a training example, or None when it is one."""
    if not isinstance(answer, dict) or sorted(answer.keys()) != sorted(KEYS):
        return 'keys'
    if answer['language'] not in ('English', 'Chinese'):
        return 'language'
    for key, (low, high) in LIMITS.items():
        value = answer[key]
        if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() and ',' not in v for v in value):
            return f'{key}_type'
        if not low <= len(value) <= high:
            return f'{key}_count'
    if not isinstance(answer['bpm'], int) or not 50 <= answer['bpm'] <= 200:
        return 'bpm'
    if not isinstance(answer['instrumental'], bool) or not isinstance(answer['lyrics'], str):
        return 'types'
    if answer['instrumental']:
        return None if answer['vocal'] == [] and answer['lyrics'] == '' else 'instrumental_has_words'
    if not answer['vocal']:
        return 'sung_without_vocal'
    lines = lay(answer['lyrics'])
    tags = [line.lower() for line in lines if re.fullmatch(r'\[[^\]]+\]', line)]
    if tags != SECTIONS:
        return 'sections'
    blocks: list[list[str]] = []
    for line in lines:
        if re.fullmatch(r'\[[^\]]+\]', line):
            blocks.append([])
        else:
            blocks[-1].append(line)
    if any(len(block) != 4 for block in blocks):
        return 'lines_per_section'
    if [l.lower() for l in blocks[1]] != [l.lower() for l in blocks[3]]:
        return 'chorus_not_repeated'
    distinct = lambda block: len({re.sub(r'\W+', ' ', l.lower()).strip() for l in block})
    # A verse is four different lines; a chorus may sing its hook twice (three different lines),
    # but two lines sung twice is not a chorus.
    if distinct(blocks[0]) < 4 or distinct(blocks[2]) < 4:
        return 'line_repeated_in_verse'
    if distinct(blocks[1]) < 3:
        return 'chorus_two_lines_twice'
    if len({re.sub(r'\W+', ' ', l.lower()).strip() for l in blocks[0] + blocks[2]}) < 8:
        return 'verses_alike'
    for block in blocks:
        for line in block:
            if not 5 <= syllables(line) <= 11:
                return 'line_length'
    low = answer['lyrics'].lower()
    if any(cliche in low for cliche in CLICHES):
        return 'cliche'
    if RELIGIOUS.search(low):
        return 'religious'
    return None


def tidy(answer) -> dict:
    """The answer as B-Side lays it out: lyrics one line per line, sections apart, tags lowercase."""
    if answer['instrumental']:
        return answer
    out, section = [], []
    for line in lay(answer['lyrics']):
        if re.fullmatch(r'\[[^\]]+\]', line):
            if out:
                out.append('')
            out.append(line.lower())
        else:
            out.append(line)
    return {**answer, 'lyrics': '\n'.join(out)}


rejected: Counter = Counter()
seen_requests: set[str] = set()
seen_choruses: set[str] = set()
examples = []
for name in sorted(os.listdir(RAW)):
    if not name.endswith('.jsonl'):
        continue
    for raw_line in open(os.path.join(RAW, name), encoding='utf-8'):
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            item = json.loads(raw_line)
        except json.JSONDecodeError:
            rejected['not_json'] += 1
            continue
        description = str(item.get('description', '')).strip()
        if not description:
            rejected['no_description'] += 1
            continue
        answer = item.get('answer')
        # One tag that is two ("warm, vintage sound") becomes the two tags it names; the
        # counts below still have to hold, so this never stretches a list past its limit.
        if isinstance(answer, dict):
            for key in LIMITS:
                if isinstance(answer.get(key), list) and all(isinstance(v, str) for v in answer[key]):
                    answer[key] = [part.strip() for v in answer[key] for part in v.split(',') if part.strip()]
        why = check(answer)
        if why is not None:
            rejected[why] += 1
            continue
        key = re.sub(r'\W+', ' ', description.lower()).strip()
        if key in seen_requests:
            rejected['duplicate_request'] += 1
            continue
        answer = tidy(item['answer'])
        chorus = ''
        if not answer['instrumental']:
            chorus = answer['lyrics'].split('[chorus]\n', 1)[1].split('\n\n', 1)[0].lower()
            if chorus in seen_choruses:
                rejected['duplicate_chorus'] += 1
                continue
            seen_choruses.add(chorus)
        seen_requests.add(key)
        switch = answer['instrumental'] and random.random() < 0.4
        system = SYSTEM_INSTRUMENTAL if switch else SYSTEM_SUNG
        content = json.dumps(answer, ensure_ascii=False)
        examples.append({
            'id': item.get('id') or f'{name}-{len(examples)}',
            # The genre the chunk asked for (a writer now and then gives a list).
            'genre': item.get('genre') if isinstance(item.get('genre'), str) else ' / '.join(map(str, item.get('genre') or [])),
            'description': description,
            'instrumental_requested': switch,
            'system': system,
            'answer': answer,
            'messages': [
                {'role': 'system', 'content': system},
                {'role': 'user', 'content': description},
                {'role': 'assistant', 'content': content},
            ],
            'title': chorus.split('\n', 1)[0] if chorus else None,
        })

with open(OUT, 'w', encoding='utf-8') as out:
    for example in examples:
        out.write(json.dumps(example, ensure_ascii=False) + '\n')

genres = Counter(e['genre'] for e in examples)
print(f'{len(examples)} examples ({sum(1 for e in examples if e["answer"]["instrumental"])} instrumental) -> {OUT}')
print('rejected:', dict(rejected.most_common()))
print('per genre:', dict(sorted(genres.items())))
