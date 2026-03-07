import { Info, AlertTriangle } from "lucide-react";
import MarkdownText from "@/components/markdown-text";
import { AgentAvatar } from "@/components/agent-avatar";

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  /** Hide avatar for consecutive same-role messages */
  isFollowUp?: boolean;
  /** System message icon (replaces agent avatar) */
  systemIcon?: "info" | "error";
}

export function ChatMessage({ role, content, isFollowUp, systemIcon }: ChatMessageProps) {
  if (role === "user") {
    return (
      <div className="flex justify-end mt-4">
        <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-sm whitespace-pre-wrap">
          {content}
        </div>
      </div>
    );
  }

  const renderIcon = () => {
    if (isFollowUp && !systemIcon) return null;
    if (systemIcon === "info") return <Info className="h-8 w-8 text-primary" />;
    if (systemIcon === "error") return <AlertTriangle className="h-8 w-8 text-primary" />;
    return <AgentAvatar size={32} />;
  };

  return (
    <div className="flex gap-3 mt-4">
      {/* Avatar column — fixed width so content aligns */}
      <div className="w-8 shrink-0 pt-0.5">
        {renderIcon()}
      </div>
      {/* Content */}
      <div className="min-w-0 max-w-[90%] text-sm">
        <MarkdownText>{content}</MarkdownText>
      </div>
    </div>
  );
}
