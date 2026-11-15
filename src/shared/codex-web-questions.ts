import type { CodexRecord } from './codex-web'

export interface AsyncQuestion {
  title: string
  options: string[]
}
export interface QuestionReply {
  questionItemId: string
  question: string
  answer: string
}
const opening = '<send_user_message_question_reply>'
const closing = '</send_user_message_question_reply>'
export const questionId = (itemId: string, index: number): string =>
  JSON.stringify(['request_user_input_async', itemId, index])

export function asyncQuestions(item: CodexRecord): AsyncQuestion[] | undefined {
  if (item.type !== 'agentMessage' || item.delivery !== 'async' || !Array.isArray(item.questions))
    return
  if (!item.questions.length || item.questions.length > 16) return
  let size = 0
  const result: AsyncQuestion[] = []
  for (const question of item.questions) {
    if (typeof question?.title !== 'string' || !question.title.trim()) return
    const options = question.options ?? []
    if (!Array.isArray(options) || options.length > 32) return
    if (options.some((option) => typeof option !== 'string' || !option.trim())) return
    size += question.title.length + options.reduce((sum, option) => sum + option.length, 0)
    if (size > 16000) return
    result.push({ title: question.title, options })
  }
  return result
}

export function parseQuestionReply(text: string): QuestionReply[] | undefined {
  if (text.length > 200000) return
  text = text.trim()
  if (text.startsWith('# Context from my IDE setup:\n')) {
    const delimiter = '\n## My request for Codex:\n'
    const index = text.lastIndexOf(delimiter)
    if (index < 0) return
    text = text.slice(index + delimiter.length).trim()
  }
  if (!text.startsWith(opening) || !text.endsWith(closing)) return
  try {
    const value = JSON.parse(text.slice(opening.length, -closing.length))
    const replies: QuestionReply[] = Array.isArray(value) ? value : [value]
    if (!replies.length || replies.length > 32) return
    if (
      replies.some(
        (reply) =>
          typeof reply?.questionItemId !== 'string' ||
          !reply.questionItemId ||
          reply.questionItemId.length > 512 ||
          typeof reply.question !== 'string' ||
          typeof reply.answer !== 'string'
      )
    )
      return
    return replies.map(({ questionItemId, question, answer }) => ({
      questionItemId,
      question,
      answer
    }))
  } catch {
    return
  }
}

export function itemQuestionReplies(item: CodexRecord): QuestionReply[] {
  if (item.type !== 'userMessage') return []
  return (item.content || []).flatMap((part: CodexRecord) =>
    part.type === 'text' && typeof part.text === 'string' ? parseQuestionReply(part.text) || [] : []
  )
}

export function formatQuestionReplies(replies: QuestionReply[]): string {
  return replies.map((reply) => `问题：${reply.question}\n回答：${reply.answer}`).join('\n\n')
}

export function serializeQuestionReplies(replies: QuestionReply[]): string {
  const encoder = new TextEncoder()
  const values = replies.map((reply) => {
    let question = '',
      bytes = 0
    for (const char of reply.question) {
      bytes += encoder.encode(char).length
      if (bytes > 512) break
      question += char
    }
    return { ...reply, question: question.replace(/[\r\n]/g, ' ') }
  })
  return `${opening}\n${JSON.stringify(values)}\n${closing}`
}
