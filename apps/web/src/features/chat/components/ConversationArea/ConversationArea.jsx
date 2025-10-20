import { useMemo } from 'react';
import ConversationHeader from '../ConversationHeader';

function createMemoizedRenderSummary(renderSummary) {
  if (!renderSummary) return undefined;

  if (typeof renderSummary !== 'function') {
    const node = renderSummary;
    return () => node;
  }

  return (() => {
    let cachedArgs = null;
    let cachedNode = null;

    return (...args) => {
      if (
        !cachedArgs ||
        cachedArgs.length !== args.length ||
        cachedArgs.some((value, index) => value !== args[index])
      ) {
        cachedArgs = args;
        cachedNode = renderSummary(...args);
      }

      return cachedNode;
    };
  })();
}

/**
 * Container for the active conversation area. Renders the sticky header once
 * (with the summary renderer) followed by the rest of the conversation body.
 */
export default function ConversationArea({ headerProps = {}, renderSummary, children }) {
  const memoizedRenderSummary = useMemo(
    () => createMemoizedRenderSummary(renderSummary),
    [renderSummary],
  );

  const content = useMemo(
    () => (typeof children === 'function'
      ? children({ renderSummary: memoizedRenderSummary })
      : children),
    [children, memoizedRenderSummary],
  );

  return (
    <section className="flex h-full flex-col">
      <div className="relative z-10">
        <ConversationHeader {...headerProps} renderSummary={memoizedRenderSummary} />
      </div>
      <div className="flex-1 overflow-hidden">
        {content}
      </div>
    </section>
  );
}
