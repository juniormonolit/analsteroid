import json, re, sys
data = json.load(open(sys.argv[1], encoding='utf-8'))
G = [  # (группа, регэксп по тексту в нижнем регистре)
 ('Пиломатериалы', r'пилмат|пиломатериал|доска|доску|обвязк|деревянное сборное'),
 ('Кровельные материалы, водосточные системы', r'кровл|черепиц|водосточ|фальцев'),
 ('Окна и двери', r'окн[ао]|окнам|двер|замерщик'),
 ('Теплоизоляция и утеплитель', r'утеплител|\bват[ауы]?\b|эппс|пенополистирол|пенопласт|пароизоляц|ветро-влаг|пленк|шумоизол'),
 ('Плитные материалы', r'\bосб\b|фанер|\bцсп\b|\bгвл\b|плитные'),
 ('Гипсокартон', r'гипсокартон|подсистем'),
 ('Фасад', r'фасад(?!ную щелоч)|сайдинг|пластиковые панели|\bдпк\b|хауберк'),
 ('Деревянная отделка', r'вагонк|имитац\w* бруса|блок-хаус|деревянн\w+ отделк'),
 ('Сухие смеси', r'штукатур|\bклей\b|клей-пен|цемент|грунтовк|стяжк'),
 ('Изделия для благоустройства', r'тротуарн|бордюр|благоустройств|дорожки'),
 ('Ограждения и заборы', r'забор|штакетник|профлист|профнастил|ворот|калитк|гиттер'),
 ('Песок', r'песок|песка|подушк'),
 ('Щебень', r'щебен|щебн|\bпгс\b|\bщпс\b'),
 ('Бетон и раствор', r'(?<!газо)бетон(?!н\w* забор)|раствор|монолитн|отмостк|автобетононасос'),
 ('Газобетон', r'газобетон|блоки на 2'),
 ('Арматура стальная и проволока', r'арматур'),
 ('Плиты перекрытия ЖБИ', r'плиты перекрыт|плиты нужны'),
 ('Кольца ЖБИ', r'септик|кольц'),
 ('ФБС', r'\bфбс\b'),
 ('Трубы профильные стальные', r'трубы профильн|профильн\w* труб'),
 ('Прочий металлопрокат', r'швеллер|металлопрокат|балки'),
 ('Рулонная гидроизоляция', r'гидроизоляц'),
 ('Грунт и навоз', r'грунт плодород|грунт \(|\bгрунт\b(?!овк)'),
 ('Керамзит', r'керамзит'),
 ('Сваи ЖБИ', r'\bсва[ия]\b|\bсвай'),
 ('Асфальт и асфальтобетон', r'асфальт'),
 ('Напольные покрытия', r'чистов\w* пол|покрытие\s+пола|напольн'),
 ('ЛКМ (Лакокрасочные материалы)', r'краск'),
 ('Кирпич и другие стеновые материалы', r'кирпич'),
]
def groups_in(text):
    t = text.lower()
    return [g for g, rx in G if re.search(rx, t)]
SHEET_HOUSE = {0: 'frame', 1: 'aerated', 2: 'any', 3: 'any'}
rules = {}
def title(t): return (t.get('title') or '').replace('\n', ' ').strip()
def kids(t): return (t.get('children', {}) or {}).get('attached', []) or []
def collect(t, frm, house, depth=0):
    for c in kids(t):
        txt = title(c)
        if '?' in txt or depth >= 0:
            for g in groups_in(txt):
                if g in frm: continue
                for f in frm:
                    k = (house, f, g)
                    # самый «верхний» (короткий путь) вопрос — лучшая подсказка
                    if k not in rules or rules[k][0] > depth:
                        rules[k] = (depth, txt)
        collect(c, frm, house, depth + 1)
for si, sheet in enumerate(data):
    house = SHEET_HOUSE.get(si, 'any')
    root = sheet['rootTopic']
    if si == 3:  # БЕТОН: весь лист — «после бетона»
        collect(root, ['Бетон и раствор'], house); continue
    def find_shipped(t):
        for c in kids(t):
            tt = title(c)
            if tt.lower().startswith('отгрузили'):
                frm = groups_in(tt.replace('Отгрузили', '').replace('отгрузили', ''))
                if frm: collect(c, frm[:1], house)
                find_shipped(c)
            elif tt.lower().startswith('другие') or tt.lower().startswith('утеплитель - техн'):
                if tt.lower().startswith('утеплитель'): collect(c, ['Теплоизоляция и утеплитель'], house)
                find_shipped(c)
    find_shipped(root)
out = [{'house': h, 'from': f, 'to': g, 'ask': txt, 'depth': d} for (h, f, g), (d, txt) in rules.items()]
out.sort(key=lambda r: (r['house'], r['from'], r['depth']))
json.dump(out, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
from collections import defaultdict
by = defaultdict(list)
for r in out: by[(r['house'], r['from'])].append(f"{r['to']} (ур.{r['depth']})")
for k, v in by.items(): print(k[0], '|', k[1], '→', '; '.join(v))
print('правил:', len(out))
