/**
 * The 写作风格 block as a test fixture.
 *
 * Since SOP 3.6 the style lives in the 全书大纲 layer and is a *prose gate*: seven
 * named elements, and `novel_write` refuses a chapter while any of them is empty.
 * Several suites walk the pipeline far enough to write prose, so they all need
 * the same block — one definition, three spellings (core state, tool call
 * arguments, and a plain outline patch), so the suites cannot disagree about
 * what "the style is written" means.
 *
 * @module test/style-fixture
 */

import type { OutlineStyleField } from '../src/core/types.ts'

/** A 写作风格 block that satisfies the prose gate. */
export const STYLE_BLOCK: Readonly<Record<OutlineStyleField, string>> = {
  tone: '冷硬克制，短句为主；像雨敲在铁皮上。',
  perspective: '第三人称限知，镜头贴主角，不切视角。',
  rhythm: '短句为主，单句成段只用在情绪拐点，一段不超过四行。',
  diction: '书面语与口语之间，少用形容词，禁用网络热词。',
  dialogue: '对话占四成，内心戏用动作落地，环境描写一句带过。',
  emotion: '情绪落在手上的动作与呼吸上，爽点给足不解释。',
  taboos: '禁止章末总结、翻译腔、滥用副词与「他知道」式内心独白。',
}

/** The same block as `novel_plan operation="outline"` parameters. */
export const STYLE_ARGS: Readonly<Record<string, string>> = {
  styleTone: STYLE_BLOCK.tone,
  stylePerspective: STYLE_BLOCK.perspective,
  styleRhythm: STYLE_BLOCK.rhythm,
  styleDiction: STYLE_BLOCK.diction,
  styleDialogue: STYLE_BLOCK.dialogue,
  styleEmotion: STYLE_BLOCK.emotion,
  styleTaboos: STYLE_BLOCK.taboos,
}

/** The same block as an outline patch, for core-level fixtures. */
export const STYLE_OUTLINE_PATCH: { readonly style: Readonly<Record<OutlineStyleField, string>> } = {
  style: STYLE_BLOCK,
}
