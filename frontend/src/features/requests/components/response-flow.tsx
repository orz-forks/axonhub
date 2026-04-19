import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CopyIcon } from 'lucide-react';
import { Reasoning, ReasoningTrigger, ReasoningContent } from '@/components/ai-elements/reasoning';
import { Response as UIResponse } from '@/components/ai-elements/response';
import { Message, MessageContent } from '@/components/ai-elements/message';
import { Tool, ToolHeader, ToolContent, ToolOutput } from '@/components/ai-elements/tool';
import { CodeBlock } from '@/components/ai-elements/code-block';
import { Badge } from '@/components/ui/badge';

import { parseResponse, type ToolResultEntry } from '../utils/response-parser';

interface ResponseFlowProps {
  chunks?: any[] | null;
  body?: any;
  isLive?: boolean;
  reasoningDurationMs?: number | null;
}

const parseJson = (text: string) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/**
 * Extracts a user-visible error string from an Anthropic `*_tool_result`
 * error content payload, or returns undefined when the result is not in error.
 */
const extractErrorText = (tr: ToolResultEntry): string | undefined => {
  if (!tr.isError) return undefined;
  const c = tr.content;
  if (!c) return 'Error';
  if (typeof c === 'string') return c;
  if (typeof c === 'object' && !Array.isArray(c)) {
    if (typeof c.error_code === 'string' && typeof c.message === 'string') {
      return `${c.error_code}: ${c.message}`;
    }
    if (typeof c.error_code === 'string') return c.error_code;
    if (typeof c.message === 'string') return c.message;
  }
  return 'Error';
};

export function ResponseFlow({ chunks, body, isLive, reasoningDurationMs }: ResponseFlowProps) {
  const { t } = useTranslation();

  const { content, reasoning, toolCalls, toolResults } = useMemo(
    () => parseResponse(body, chunks),
    [chunks, body]
  );

  // Match tool results to the call they relate to, then collect any
  // leftover results so we can render them as standalone cards.
  const { resultsByCallId, orphanResults } = useMemo(() => {
    const byId = new Map<string, ToolResultEntry[]>();
    const orphans: ToolResultEntry[] = [];
    for (const tr of toolResults) {
      const key = tr.toolCallId;
      if (!key) {
        orphans.push(tr);
        continue;
      }
      const hasCall = toolCalls.some(tc => tc.id === key);
      if (!hasCall) {
        orphans.push(tr);
        continue;
      }
      const list = byId.get(key) ?? [];
      list.push(tr);
      byId.set(key, list);
    }
    return { resultsByCallId: byId, orphanResults: orphans };
  }, [toolCalls, toolResults]);

  const hasAny =
    content || reasoning || toolCalls.length > 0 || toolResults.length > 0;

  if (!hasAny) {
    if (isLive) {
      return (
        <div className='flex min-h-[200px] w-full items-center justify-center rounded-xl border border-dashed bg-muted/5'>
            <div className='space-y-4 text-center'>
              <div className='border-primary mx-auto h-12 w-12 animate-spin rounded-full border-b-2'></div>
              <p className='text-muted-foreground text-lg'>{t('common.loading')}</p>
            </div>
        </div>
      );
    }
    return null;
  }

  return (
    <div className='bg-muted/10 rounded-xl border p-6'>
      {isLive && (
        <div className='mb-4 flex justify-end'>
          <Badge className='bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300 gap-1.5 border-none px-2 py-0.5'>
            <span className='h-2 w-2 rounded-full bg-green-500 animate-pulse' />
            Live
          </Badge>
        </div>
      )}

      <Message from='assistant' fullWidth={true}>
        <MessageContent>
          {reasoning && (
            <Reasoning isStreaming={isLive} duration={reasoningDurationMs ? Math.ceil(reasoningDurationMs / 1000) : undefined}>
              <ReasoningTrigger />
              <ReasoningContent>{reasoning}</ReasoningContent>
            </Reasoning>
          )}

          {content && <UIResponse>{content}</UIResponse>}

          {toolCalls.length > 0 && (
            <div className='mt-4 space-y-3'>
              {toolCalls.map((tc, index) => {
                const matchedResults = tc.id ? resultsByCallId.get(tc.id) ?? [] : [];
                const hasError = matchedResults.some(r => r.isError);
                const state = isLive
                  ? 'input-available'
                  : hasError
                    ? 'output-error'
                    : matchedResults.length > 0
                      ? 'output-available'
                      : 'output-available';

                return (
                  <Tool key={tc.id || index} defaultOpen={true}>
                    <ToolHeader
                      title={tc.function?.name || 'tool'}
                      type='tool-call'
                      state={state}
                    />
                    <ToolContent>
                      {tc.id && (
                        <div className='px-4 pt-3 pb-1'>
                          <span className='text-muted-foreground font-mono text-xs'>ID: {tc.id}</span>
                        </div>
                      )}
                      <div className='space-y-2 overflow-hidden p-4'>
                        <div className='flex items-center justify-between'>
                          <h4 className='text-muted-foreground text-xs font-medium tracking-wide uppercase'>
                            {t('requests.responseFlow.parameters')}
                          </h4>
                          <button
                            type='button'
                            className='text-muted-foreground hover:text-foreground text-xs flex items-center gap-1 transition-colors cursor-pointer'
                            onClick={() => {
                              const text = typeof tc.function?.arguments === 'string'
                                ? tc.function.arguments
                                : JSON.stringify(parseJson(tc.function?.arguments || '{}'), null, 2);
                              navigator.clipboard.writeText(text);
                            }}
                          >
                            <CopyIcon className='size-3' />
                            {t('requests.responseFlow.copy')}
                          </button>
                        </div>
                        <div className='bg-muted/50 rounded-md'>
                          <CodeBlock code={JSON.stringify(parseJson(tc.function?.arguments || '{}'), null, 2)} language='json' />
                        </div>
                      </div>

                      {matchedResults.map((tr, rIdx) => (
                        <ToolOutput
                          key={`${tc.id}-result-${rIdx}`}
                          output={tr.isError ? undefined : tr.content}
                          errorText={extractErrorText(tr)}
                        />
                      ))}
                    </ToolContent>
                  </Tool>
                );
              })}
            </div>
          )}

          {orphanResults.length > 0 && (
            <div className='mt-4 space-y-3'>
              {orphanResults.map((tr, index) => (
                <Tool key={`orphan-${index}`} defaultOpen={true}>
                  <ToolHeader
                    title={tr.blockType}
                    type='tool-call'
                    state={tr.isError ? 'output-error' : 'output-available'}
                  />
                  <ToolContent>
                    {tr.toolCallId && (
                      <div className='px-4 pt-3 pb-1'>
                        <span className='text-muted-foreground font-mono text-xs'>
                          {t('requests.responseFlow.toolCallIdPrefix')}: {tr.toolCallId}
                        </span>
                      </div>
                    )}
                    <ToolOutput
                      output={tr.isError ? undefined : tr.content}
                      errorText={extractErrorText(tr)}
                    />
                  </ToolContent>
                </Tool>
              ))}
            </div>
          )}

          {!content && !toolCalls.length && !toolResults.length && isLive ? (
            <div className='flex items-center gap-2 text-sm text-muted-foreground italic'>
               <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-primary' />
               {t('common.loading')}...
            </div>
          ) : null}
        </MessageContent>
      </Message>
    </div>
  );
}
