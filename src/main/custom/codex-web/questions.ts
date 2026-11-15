import type { CodexRecord } from '../../../shared/codex-web'
import {
  asyncQuestions,
  itemQuestionReplies,
  questionId,
  serializeQuestionReplies,
  type AsyncQuestion,
  type QuestionReply
} from '../../../shared/codex-web-questions'

export class AsyncQuestionState {
  private questions = new Map<string, AsyncQuestion[]>()
  private resolved = new Map<string, { threadId: string; id: string }>()
  private sending = new Set<string>()
  private key(threadId: string, id: string): string {
    return JSON.stringify([threadId, id])
  }

  observe(threadId: string, turnId: string, item: CodexRecord): boolean {
    const questions = asyncQuestions(item)
    if (questions) {
      const key = this.key(threadId, JSON.stringify([turnId, item.id]))
      this.questions.set(key, questions)
      while (this.questions.size > 64) this.questions.delete(this.questions.keys().next().value!)
    }
    const replies = itemQuestionReplies(item)
    const ids = Array.isArray(item.webQuestionReplyIds) ? item.webQuestionReplyIds : []
    return this.resolve(threadId, [...replies.map((reply) => reply.questionItemId), ...ids])
  }

  find(threadId: string, turnId: string, itemId: string): AsyncQuestion[] | undefined {
    return this.questions.get(this.key(threadId, JSON.stringify([turnId, itemId])))
  }

  snapshot(threadId: string): Record<string, boolean> {
    return Object.fromEntries(
      [...this.resolved.values()]
        .filter((entry) => entry.threadId === threadId)
        .map((entry) => [entry.id, true])
    )
  }

  resolve(threadId: string, ids: string[]): boolean {
    let changed = false
    for (const id of ids) {
      if (typeof id !== 'string' || !id || id.length > 512) continue
      const key = this.key(threadId, id)
      if (!this.resolved.has(key)) changed = true
      this.resolved.set(key, { threadId, id })
    }
    while (this.resolved.size > 256) this.resolved.delete(this.resolved.keys().next().value!)
    return changed
  }

  async answer(
    threadId: string,
    itemId: string,
    questions: AsyncQuestion[],
    answers: unknown,
    send: (text: string) => Promise<CodexRecord>
  ): Promise<CodexRecord> {
    if (!Array.isArray(answers) || !answers.length || answers.length > questions.length)
      throw new Error('请填写要提交的回答')
    const indexes = new Set<number>()
    const replies: QuestionReply[] = answers.map((value) => {
      if (!Number.isInteger(value?.index) || !questions[value.index] || indexes.has(value.index))
        throw new Error('问题标识无效，请重新同步')
      indexes.add(value.index)
      if (typeof value.answer !== 'string' || !value.answer.trim() || value.answer.length > 12000)
        throw new Error('回答不能为空或超过 12000 个字符')
      return {
        questionItemId: questionId(itemId, value.index),
        question: questions[value.index].title,
        answer: value.answer.trim()
      }
    })
    const keys = replies.map((reply) => this.key(threadId, reply.questionItemId))
    if (
      this.resolved.has(this.key(threadId, itemId)) ||
      keys.some((key) => this.resolved.has(key) || this.sending.has(key))
    )
      throw new Error('问题已回答或正在提交，请等待同步')
    const text = serializeQuestionReplies(replies)
    if (text.length > 200000) throw new Error('回答内容过长，请分批提交')
    for (const key of keys) this.sending.add(key)
    try {
      const result = await send(text)
      this.resolve(
        threadId,
        replies.map((reply) => reply.questionItemId)
      )
      return result
    } catch (error) {
      // A native user-message event proves delivery even if the RPC acknowledgement was lost.
      if (keys.every((key) => this.resolved.has(key))) return {}
      throw error
    } finally {
      for (const key of keys) this.sending.delete(key)
    }
  }

  forget(threadId: string): void {
    for (const [key, entry] of this.resolved)
      if (entry.threadId === threadId) this.resolved.delete(key)
    for (const key of this.questions.keys())
      if (JSON.parse(key)[0] === threadId) this.questions.delete(key)
  }
}
