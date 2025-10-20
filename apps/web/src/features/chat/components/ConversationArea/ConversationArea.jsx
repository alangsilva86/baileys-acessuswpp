import ConversationHeader from '../ConversationHeader';

/**
 * Container for the active conversation area. Renders the sticky header once
 * (with the summary renderer) followed by the rest of the conversation body.
 */
export default function ConversationArea({ headerProps = {}, renderSummary, children }) {
  return (
    <section className="flex h-full flex-col">
      <div className="relative z-10">
        <ConversationHeader {...headerProps} renderSummary={renderSummary} />
      </div>
      <div className="flex-1 overflow-hidden">
        {typeof children === 'function' ? children() : children}
      </div>
    </section>
  );
}
