import type { StoryPackage } from '../types/game'

export const unregisteredCity: StoryPackage = {
  id: 'unregistered-city-quick',
  title: '无籍之城',
  summary:
    '在一个名籍决定生存资格的强规则时代，被剥离名籍的人被驱逐到边境。你经营着边境最后一座驿站，必须在日落前决定谁能留下。',
  coreRules: [
    '你是边境驿站的老板，负责接待每晚抵达的无籍者。',
    '驿站每晚只有三张宿籍；宿籍可流转，但老板不能直接指定转让对象。',
    '宿籍必须与持有者身份相符，错配会给驿站带来经营风险。',
    '没有名籍的人在日落后会迅速消亡，幸存者必须设法获得正籍。',
  ],
  visualBible:
    'Realistic ancient Chinese frontier drama in the fictional Yong dynasty. One weathered courier inn of dark timber and gray stone stands beside a massive border wall. Restrained slate, dust-brown and dim amber palette; cold wind, natural firelight, historically grounded clothing; the same faces, costumes, props and architecture in every shot; cinematic 16:9, no subtitles or text overlay.',
  openingTitle: '第一幕 · 日落将至',
  openingNarrative: '暮钟响起，四名被剥去名籍的人穿过弃名原，停在留名驿门前。你手中的《宿名簿》只有三行。',
  openingPrompt:
    'Cinematic 5-second establishing shot, ancient Chinese frontier at dusk under a strict registry empire. The camera slowly pushes through cold wind and drifting dust toward a solitary weathered courier inn beside a massive border wall. Three dim amber registry lanterns hang above the entrance, each marked as a temporary lodging permit. A distant bell announces sunset while four exhausted exiles approach from the wasteland. Somber realistic historical atmosphere, restrained colors, dramatic natural light, coherent architecture, no subtitles, no text overlay, 16:9.',
  initialOptions: ['先验看四人的驱逐文书', '让四人分别说明自己最适合承担哪份宿籍'],
  initialStats: { innOrder: 50, officialSuspicion: 15, guestTrust: 20 },
  maxTurns: 5,
  characters: [
    {
      id: 'yan-qi',
      name: '燕七',
      publicIdentity: '被控临阵脱逃的前北门戍卒',
      visibleTraits: ['熟悉边境', '警觉', '右臂负伤'],
      directorSecret: '他并非临阵脱逃，而是拒绝射杀一队没有通行籍的难民。',
      fit: { gatekeeper: 'high', lamplighter: 'conflict', scribe: 'medium' },
    },
    {
      id: 'su-buniang',
      name: '苏簿娘',
      publicIdentity: '因账册缺页被剥籍的县衙书吏',
      visibleTraits: ['识字', '心算准确', '言辞克制'],
      directorSecret: '她确实改过一页名册，但目的是替一个未登记的孩子补上名字。',
      fit: { gatekeeper: 'conflict', lamplighter: 'medium', scribe: 'high' },
    },
    {
      id: 'a-zhu',
      name: '阿烛',
      publicIdentity: '从司籍院名灯房逃出的守灯童子',
      visibleTraits: ['记忆敏锐', '熟悉名灯', '畏惧官差'],
      directorSecret: '他记得巡籍使私自销毁名籍的名单，是第一夜最危险的证人。',
      fit: { gatekeeper: 'conflict', lamplighter: 'high', scribe: 'medium' },
    },
    {
      id: 'gu-chan',
      name: '顾蝉',
      publicIdentity: '声称因商债被除名的流动药商',
      visibleTraits: ['善于谈判', '携带药箱', '衣着过于整洁'],
      directorSecret: '她是巡籍使安插的线人，但对让无籍者日落消亡已经产生动摇。',
      fit: { gatekeeper: 'medium', lamplighter: 'medium', scribe: 'conflict' },
    },
  ],
}
