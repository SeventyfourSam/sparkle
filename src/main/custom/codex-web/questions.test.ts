import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AsyncQuestionState } from './questions'
import { boundedDetail, previewItem, visibleNarrative } from '../../../shared/codex-web-history'
import {
  asyncQuestions,
  itemQuestionReplies,
  parseQuestionReply,
  questionId,
  serializeQuestionReplies
} from '../../../shared/codex-web-questions'

const item = {
  id: 'ask-1',
  type: 'agentMessage',
  delivery: 'async',
  text: '现在方便测试吗？\n- 方便\n- 暂不方便',
  questions: [{ title: '现在方便测试吗？', options: ['方便', '暂不方便'] }]
}
const reply = {
  questionItemId: questionId(item.id, 0),
  question: item.questions[0].title,
  answer: '暂不方便'
}

test('async question metadata survives bounded history without converting plain bullet lists into forms', () => {
  const preview = previewItem(item, 'turn')
  assert.equal(preview.delivery, 'async')
  assert.deepEqual(preview.questions, item.questions)
  assert.equal(visibleNarrative({ ...preview, text: '' }), true)
  assert.equal(asyncQuestions({ type: 'agentMessage', text: item.text }), undefined)
  assert.equal(
    asyncQuestions({ ...item, questions: [{ title: 'Large', options: ['a'.repeat(17000)] }] }),
    undefined
  )
  assert.equal(asyncQuestions({ ...item, questions: [{ title: 'Bad', options: [1] }] }), undefined)
})

test('answers use the native question identity and envelope, with UTF-8 bounded titles and readable previews', () => {
  assert.equal(reply.questionItemId, '["request_user_input_async","ask-1",0]')
  const text = serializeQuestionReplies([{ ...reply, question: '汉'.repeat(300) + '\n第二行' }])
  const parsed = parseQuestionReply(text)!
  assert.equal(Buffer.byteLength(parsed[0].question), 510)
  assert.equal(parsed[0].answer, reply.answer)
  assert.equal(parseQuestionReply(`quoted ${text}`), undefined)
  assert.equal(parseQuestionReply('```\n' + text + '\n```'), undefined)
  assert.deepEqual(
    parseQuestionReply(
      '# Context from my IDE setup:\nfiles\n## My request for Codex:\n' +
        serializeQuestionReplies([reply])
    ),
    [reply]
  )
  const source = {
    type: 'userMessage',
    id: 'u',
    content: [{ type: 'text', text: serializeQuestionReplies([reply]) }]
  }
  assert.deepEqual(itemQuestionReplies(source), [reply])
  const preview = previewItem(source, 'turn')
  assert.deepEqual(preview.webQuestionReplyIds, [reply.questionItemId])
  assert.match(preview.content[0].text, /回答：暂不方便/)
  assert.equal(preview.content[0].text.includes('<send_user_message_question_reply>'), false)
  const full = boundedDetail(
    {
      ...source,
      content: [
        { type: 'text', text: serializeQuestionReplies([{ ...reply, answer: 'a'.repeat(70000) }]) }
      ]
    },
    'turn'
  )
  assert.equal(full.content[0].text.includes('<send_user_message_question_reply>'), false)
  assert.equal(full.webTruncated, true)
})

test('async answers prevent concurrent duplicates, preserve retry after failure, and recognize native acknowledgements', async () => {
  const state = new AsyncQuestionState()
  state.observe('thread', 'turn', item)
  const questions = state.find('thread', 'turn', item.id)!
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = state.answer(
    'thread',
    item.id,
    questions,
    [{ index: 0, answer: '方便' }],
    async () => {
      await waiting
      return {}
    }
  )
  await assert.rejects(
    state.answer('thread', item.id, questions, [{ index: 0, answer: '暂不方便' }], async () =>
      assert.fail('duplicate send')
    ),
    /正在提交/
  )
  release()
  await first
  assert.equal(state.snapshot('thread')[reply.questionItemId], true)
  await assert.rejects(
    state.answer('thread', item.id, questions, [{ index: 0, answer: 'again' }], async () =>
      assert.fail('answered')
    ),
    /已回答/
  )
  state.forget('thread')
  state.observe('thread', 'turn', item)
  await assert.rejects(
    state.answer('thread', item.id, questions, [{ index: 0, answer: '方便' }], async () => {
      throw new Error('offline')
    }),
    /offline/
  )
  assert.deepEqual(state.snapshot('thread'), {})
  await state.answer('thread', item.id, questions, [{ index: 0, answer: '方便' }], async () => {
    state.observe('thread', 'turn', {
      type: 'userMessage',
      content: [{ type: 'text', text: serializeQuestionReplies([reply]) }]
    })
    throw new Error('lost acknowledgement')
  })
  assert.equal(state.snapshot('thread')[reply.questionItemId], true)
})

test('replayed and legacy answers resolve questions without authorizing invalid or empty submissions', async () => {
  const state = new AsyncQuestionState()
  const questions = asyncQuestions(item)!
  const send = async (): Promise<never> => assert.fail('invalid submission reached Codex')
  await assert.rejects(
    state.answer('thread', item.id, questions, [{ index: 9, answer: 'yes' }], send),
    /标识/
  )
  await assert.rejects(
    state.answer('thread', item.id, questions, [{ index: 0, answer: ' ' }], send),
    /不能为空/
  )
  await assert.rejects(
    state.answer(
      'thread',
      item.id,
      questions,
      [
        { index: 0, answer: 'yes' },
        { index: 0, answer: 'no' }
      ],
      send
    ),
    /填写|标识/
  )
  state.observe('thread', 'turn', {
    type: 'userMessage',
    content: [
      { type: 'text', text: serializeQuestionReplies([{ ...reply, questionItemId: item.id }]) }
    ]
  })
  state.observe('thread', 'turn', item)
  await assert.rejects(
    state.answer('thread', item.id, questions, [{ index: 0, answer: 'yes' }], send),
    /已回答/
  )
})
