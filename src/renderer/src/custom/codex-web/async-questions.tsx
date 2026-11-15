import { createContext, useContext, useEffect, useState } from 'react'
import type { CodexRecord } from '../../../../shared/codex-web'
import { asyncQuestions, questionId } from '../../../../shared/codex-web-questions'
import { HistoryContext } from './lazy-details'
import { LinkedText } from './content-links'
import './async-questions.css'
type Values = Record<number, { choice: number | null; text: string }>
const drafts = new Map<string, Values>()

export const AsyncQuestionContext = createContext<{
  online: boolean
  answers: Record<string, boolean>
  activeTurnId?: string
}>({ online: false, answers: {} })

export function AsyncQuestions({ item }: { item: CodexRecord }): React.JSX.Element | null {
  const { command, target } = useContext(HistoryContext)
  const context = useContext(AsyncQuestionContext)
  const questions = asyncQuestions(item)
  const draftKey = JSON.stringify([target?.instanceId, target?.threadId, item.id])
  const [draft, setDraft] = useState(() => ({ key: draftKey, values: drafts.get(draftKey) || {} }))
  const values = draft.key === draftKey ? draft.values : drafts.get(draftKey) || {}
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const resolved = questions?.every(
    (_, index) => context.answers[questionId(item.id, index)] || context.answers[item.id]
  )
  useEffect(() => {
    if (resolved) drafts.delete(draftKey)
  }, [resolved, draftKey])
  if (!questions) return null
  const state = (index: number): { choice: number | null; text: string } =>
    values[index] || { choice: questions[index].options.length ? 0 : null, text: '' }
  const answered = (index: number): boolean =>
    !!context.answers[questionId(item.id, index)] || !!context.answers[item.id]
  const pending = questions.map((_, index) => index).filter((index) => !answered(index))
  const answer = (index: number): string => {
    const value = state(index)
    return value.choice === null ? value.text : questions[index].options[value.choice] || ''
  }
  const locked = busy || !context.online || !target
  const set = (index: number, choice: number | null, text = state(index).text): void => {
    const next = { ...values, [index]: { choice, text } }
    drafts.set(draftKey, next)
    while (drafts.size > 32) drafts.delete(drafts.keys().next().value!)
    setDraft({ key: draftKey, values: next })
    setError('')
  }
  const submit = async (): Promise<void> => {
    if (locked || !pending.length || pending.some((index) => !answer(index).trim())) return
    setBusy(true)
    setError('')
    try {
      await command('answer', {
        ...target,
        turnId: item.webTurnId,
        itemId: item.id,
        ...(context.activeTurnId ? { expectedTurnId: context.activeTurnId } : {}),
        answers: pending.map((index) => ({ index, answer: answer(index) }))
      })
      drafts.delete(draftKey)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="async-question-card" aria-label="Codex 提问">
      <div className="async-question-heading">
        <strong>Codex 提问</strong>
        <span>{pending.length ? '选择或填写后提交' : '已回答'}</span>
      </div>
      {questions.map((question, index) => (
        <fieldset key={questionId(item.id, index)} disabled={locked || answered(index)}>
          <legend>
            <LinkedText text={question.title} />
          </legend>
          {answered(index) ? (
            <p className="async-question-resolved">已回答</p>
          ) : (
            <>
              {!!question.options.length && (
                <div className="question-options">
                  {question.options.map((option, optionIndex) => (
                    <label
                      key={optionIndex}
                      className={`question-option ${state(index).choice === optionIndex ? 'selected' : ''}`}
                    >
                      <input
                        type="radio"
                        name={`${item.id}:${index}`}
                        checked={state(index).choice === optionIndex}
                        onChange={() => set(index, optionIndex)}
                      />
                      <span>
                        <LinkedText text={option} />
                      </span>
                    </label>
                  ))}
                  <label
                    className={`question-option ${state(index).choice === null ? 'selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name={`${item.id}:${index}`}
                      checked={state(index).choice === null}
                      onChange={() => set(index, null)}
                    />
                    <span>自己填写</span>
                  </label>
                </div>
              )}
              {state(index).choice === null && (
                <textarea
                  aria-label={`回答：${question.title}`}
                  placeholder="输入你的回答"
                  rows={2}
                  value={state(index).text}
                  maxLength={12000}
                  onChange={(event) => set(index, null, event.target.value)}
                />
              )}
            </>
          )}
        </fieldset>
      ))}
      {error && (
        <p className="async-question-error" role="alert">
          {error}
        </p>
      )}
      {!!pending.length && (
        <button
          type="button"
          className="button primary"
          disabled={locked || pending.some((index) => !answer(index).trim())}
          onClick={() => void submit()}
        >
          {busy ? '正在提交…' : '提交回答'}
        </button>
      )}
    </section>
  )
}
