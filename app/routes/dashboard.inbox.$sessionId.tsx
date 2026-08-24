import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, Form, useNavigation, Link, useFetcher } from "@remix-run/react";
import { prisma } from "~/database/db.server";
import { getAccessibleProjectScope, requireProjectAccess } from "~/lib/project-access.server";
import { ChevronLeft, User, Bot, Send, Calendar, Globe, Clock, MessageSquare, Star, Archive, Tag, X, UserPlus, Download, MessageSquareText } from "lucide-react";
import { format } from "date-fns";
import { useEffect, useRef, useState } from "react";
import { createChatSocket } from "~/lib/partykit.client";
import { createRealtimeClientToken } from "~/lib/partykit.server";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const scope = await getAccessibleProjectScope(request);
  const session = await prisma.chatSession.findFirst({
    where: { id: params.sessionId, project: scope.projectWhere },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      project: { select: { id: true, name: true, userId: true } },
      tags: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!session) {
    return redirect("/dashboard/inbox");
  }

  await prisma.chatSession.update({
    where: { id: params.sessionId },
    data: { isRead: true },
  });

  let cannedResponses: { id: string; title: string; body: string }[] = [];
  try {
    cannedResponses = await prisma.cannedResponse.findMany({
      where: { projectId: session.project.id },
      orderBy: { title: "asc" },
      select: { id: true, title: true, body: true },
    });
  } catch (e) {
    // Table may not exist until migration/schema-sync runs — inbox still works.
    console.warn("[Inbox] cannedResponse lookup failed:", (e as any)?.message || e);
  }

  return json({ session, cannedResponses, realtimeToken: await createRealtimeClientToken(session.id, "agent") });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const formData = await request.formData();
  const action = formData.get("_action");

  // Authorize: session must be on an accessible project
  const scope = await getAccessibleProjectScope(request);
  const sessionMeta = await prisma.chatSession.findFirst({
    where: { id: params.sessionId, project: scope.projectWhere },
    select: {
      id: true,
      projectId: true,
      isStarred: true,
      isArchived: true,
      mode: true,
      project: { select: { name: true } },
    },
  });
  if (!sessionMeta) {
    return action === "export_transcript"
      ? json({ error: "Not found" }, { status: 404 })
      : redirect("/dashboard/inbox");
  }

  if (action === "export_transcript") {
    // Read-only export — VIEWER+ already authorized via membership scope above
    const session = await (prisma.chatSession as any).findUnique({
      where: { id: params.sessionId },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        project: { select: { name: true } },
      },
    });
    if (!session) {
      return json({ error: "Not found" }, { status: 404 });
    }

    const csv = [
      ["Timestamp", "Sender", "Message"].join(","),
      ...session.messages.map((m: any) =>
        [
          `"${new Date(m.createdAt).toISOString()}"`,
          `"${m.role === "user" ? "Customer" : "Assistant"}"`,
          `"${(m.content || "").replace(/"/g, '""')}"`,
        ].join(",")
      ),
    ].join("\n");

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="transcript-${params.sessionId}.csv"`,
      },
    });
  }

  // Mutations require ADMIN+
  await requireProjectAccess(request, sessionMeta.projectId, { minRole: "ADMIN" });
  
  if (action === "toggle_mode") {
    const newMode = sessionMeta.mode === "human" ? "ai" : "human";
    await prisma.chatSession.update({
      where: { id: params.sessionId },
      data: { mode: newMode }
    });
    return json({ success: true });
  }

  if (action === "toggle_star") {
    await prisma.chatSession.update({
      where: { id: params.sessionId },
      data: { isStarred: !sessionMeta.isStarred },
    });
    return json({ success: true });
  }

  if (action === "toggle_archive") {
    await prisma.chatSession.update({
      where: { id: params.sessionId },
      data: { isArchived: !sessionMeta.isArchived },
    });
    return json({ success: true });
  }

  if (action === "add_tag") {
    const label = (formData.get("label") as string)?.trim().toLowerCase();
    const color = (formData.get("color") as string) || "#6366f1";
    if (!label) return json({ error: "Label required" }, { status: 400 });
    await prisma.conversationTag.upsert({
      where: { sessionId_label: { sessionId: params.sessionId!, label } },
      create: { sessionId: params.sessionId!, label, color },
      update: {},
    });
    return json({ success: true });
  }

  if (action === "remove_tag") {
    const tagId = formData.get("tagId") as string;
    await prisma.conversationTag.delete({ where: { id: tagId } });
    return json({ success: true });
  }

  if (action === "assign") {
    const assignedTo = (formData.get("assignedTo") as string)?.trim() || null;
    await prisma.chatSession.update({
      where: { id: params.sessionId },
      data: { assignedTo },
    });
    return json({ success: true });
  }

  const content = formData.get("content") as string;

  if (!content) return json({ error: "Content is required" }, { status: 400 });

  await prisma.message.create({
    data: {
      sessionId: params.sessionId!,
      role: "assistant",
      content,
    },
  });

  await prisma.chatSession.update({
    where: { id: params.sessionId },
    data: { updatedAt: new Date() }
  });

  return json({ success: true });
}

export default function SessionDetail() {
  const { session, cannedResponses, realtimeToken } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const formRef = useRef<HTMLFormElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const replyTextareaRef = useRef<HTMLTextAreaElement>(null);
  
  const fetcher = useFetcher();
  const replyFetcher = useFetcher();
  const resolveFetcher = useFetcher();
  
  const isSending = navigation.state === "submitting" || replyFetcher.state === "submitting";

  const [localMessages, setLocalMessages] = useState<any[]>(session.messages);
  const [showTagInput, setShowTagInput] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [showCanned, setShowCanned] = useState(false);

  const insertCanned = (body: string) => {
    const el = replyTextareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + body + el.value.slice(end);
    el.value = next;
    const caret = start + body.length;
    el.focus();
    el.setSelectionRange(caret, caret);
    setShowCanned(false);
  };

  useEffect(() => {
    setLocalMessages(session.messages);
  }, [session.messages]);

  // Connect to PartyKit for real-time delivery in the inbox
  useEffect(() => {
    const socket = createChatSocket(session.id, realtimeToken);
    if (!socket) return;

    const listener = (evt: MessageEvent) => {
      try {
        const data = JSON.parse(evt.data);
        if (data.type === "message") {
          setLocalMessages((prev) => {
            // Avoid duplicates
            if (prev.some((m: any) => m.content === data.content && m.role === data.role)) {
              return prev;
            }
            return [
              ...prev,
              {
                id: Math.random().toString(),
                role: data.role,
                content: data.content,
                createdAt: new Date().toISOString(),
              },
            ];
          });
        }
      } catch (err) {
        console.warn("[Agent Inbox Socket] Error parsing message:", err);
      }
    };

    socket.addEventListener("message", listener as any);
    return () => {
      socket.close();
    };
  }, [session.id, realtimeToken]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [localMessages]);

  useEffect(() => {
    if (replyFetcher.state === "idle" && !isSending) {
      formRef.current?.reset();
    }
  }, [replyFetcher.state, isSending]);

  const handleAgentReplySubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const content = formData.get("content") as string;
    if (!content?.trim()) return;

    // Optimistically update
    setLocalMessages((prev) => [
      ...prev,
      {
        id: "temp-" + Date.now(),
        role: "assistant",
        content,
        createdAt: new Date().toISOString(),
      },
    ]);

    replyFetcher.submit(
      JSON.stringify({ sessionId: session.id, content }),
      { method: "post", action: "/api/agent-reply", encType: "application/json" }
    );
    e.currentTarget.reset();
  };

  const handleResolveSession = () => {
    resolveFetcher.submit(
      JSON.stringify({ sessionId: session.id }),
      { method: "post", action: "/api/resolve-session", encType: "application/json" }
    );
  };

  return (
    <div className="h-[calc(100vh-theme(spacing.32))] flex flex-col bg-white border border-zinc-100 rounded-[40px] overflow-hidden">
      {/* Detail Header */}
      <div className="p-6 border-b border-zinc-50 bg-white flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/dashboard/inbox" className="p-2 hover:bg-zinc-50 rounded-xl transition-colors">
            <ChevronLeft className="w-5 h-5 text-zinc-400" />
          </Link>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-zinc-100 rounded-full flex items-center justify-center">
              <User className="text-zinc-400 w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold">{session.customerEmail || "Guest User"}</h2>
              <div className="flex items-center gap-2 text-[10px] text-text-muted font-bold uppercase tracking-wider">
                <span className="flex items-center gap-1"><Globe className="w-3 h-3" /> {session.project.name}</span>
                <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> ID: {session.id.slice(0, 8)}</span>
                {(session as any).pageUrl && (
                  <a
                    href={(session as any).pageUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={(session as any).pageTitle || (session as any).pageUrl}
                    className="flex items-center gap-1 text-primary hover:underline max-w-[200px] truncate normal-case"
                  >
                    <MessageSquare className="w-3 h-3 shrink-0" />
                    {(session as any).pageTitle || new URL((session as any).pageUrl).pathname}
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {/* Star button */}
          <fetcher.Form method="post">
            <input type="hidden" name="_action" value="toggle_star" />
            <button
              type="submit"
              title={session.isStarred ? "Unstar" : "Star"}
              className={`p-2.5 rounded-xl border transition-all ${
                session.isStarred
                  ? "bg-yellow-50 border-yellow-200 text-yellow-500"
                  : "bg-zinc-50 border-zinc-100 text-zinc-400 hover:bg-zinc-100"
              }`}
            >
              <Star className="w-4 h-4" fill={session.isStarred ? "currentColor" : "none"} />
            </button>
          </fetcher.Form>

          {/* Archive button */}
          <fetcher.Form method="post">
            <input type="hidden" name="_action" value="toggle_archive" />
            <button
              type="submit"
              title={session.isArchived ? "Unarchive" : "Archive"}
              className="p-2.5 rounded-xl border bg-zinc-50 border-zinc-100 text-zinc-400 hover:bg-zinc-100 transition-all"
            >
              <Archive className="w-4 h-4" />
            </button>
          </fetcher.Form>

           <Form method="post">
              <input type="hidden" name="_action" value="toggle_mode" />
              <button 
                type="submit"
                className={`px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 ${
                  session.mode === 'human' 
                    ? 'bg-amber-100 text-amber-600 border border-amber-200' 
                    : 'bg-zinc-50 text-zinc-400 border border-zinc-100 hover:bg-zinc-100'
                }`}
              >
                {session.mode === 'human' ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
                {session.mode === 'human' ? 'Human Mode Active' : 'Enable Live Takeover'}
              </button>
           </Form>

          <Form method="post">
            <input type="hidden" name="_action" value="export_transcript" />
            <button
              type="submit"
              className="px-4 py-2 rounded-xl text-xs font-black uppercase tracking-widest transition-all flex items-center gap-2 bg-zinc-50 text-zinc-400 border border-zinc-100 hover:bg-zinc-100"
            >
              <Download className="w-3.5 h-3.5" /> Transcript
            </button>
          </Form>
        </div>
      </div>

      {/* Tags and Assign Panel */}
      <div className="px-6 py-3 border-b border-zinc-50 bg-white flex items-center gap-6 flex-wrap">

        {/* Tags */}
        <div className="flex items-center gap-2 flex-wrap flex-1">
          <Tag className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
          {session.tags.map((tag: any) => (
            <span
              key={tag.id}
              className="inline-flex items-center gap-1 text-[10px] font-black px-2.5 py-1 rounded-full uppercase tracking-widest"
              style={{ backgroundColor: tag.color + "20", color: tag.color, border: `1px solid ${tag.color}40` }}
            >
              {tag.label}
              <fetcher.Form method="post" className="inline">
                <input type="hidden" name="_action" value="remove_tag" />
                <input type="hidden" name="tagId" value={tag.id} />
                <button type="submit" className="ml-0.5 hover:opacity-60">
                  <X className="w-2.5 h-2.5" />
                </button>
              </fetcher.Form>
            </span>
          ))}
          {/* Add tag form */}
          {showTagInput ? (
            <fetcher.Form
              method="post"
              onSubmit={() => { setShowTagInput(false); setTagInput(""); }}
              className="flex items-center gap-1"
            >
              <input type="hidden" name="_action" value="add_tag" />
              <input
                name="label"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder="tag name"
                autoFocus
                className="w-24 px-2 py-0.5 text-xs border border-brand-border rounded-lg outline-none focus:border-primary"
              />
              <button type="submit" className="text-[10px] font-black text-primary px-2 py-1 hover:underline">
                Add
              </button>
              <button type="button" onClick={() => setShowTagInput(false)} className="text-[10px] text-zinc-400 px-1">
                ✕
              </button>
            </fetcher.Form>
          ) : (
            <button
              onClick={() => setShowTagInput(true)}
              className="text-[10px] font-black text-zinc-400 hover:text-primary transition-colors px-2 py-1 rounded-lg hover:bg-brand-light"
            >
              + Add tag
            </button>
          )}
        </div>

        {/* Assign to */}
        <fetcher.Form method="post" className="flex items-center gap-2 shrink-0">
          <input type="hidden" name="_action" value="assign" />
          <UserPlus className="w-3.5 h-3.5 text-zinc-400" />
          <input
            name="assignedTo"
            defaultValue={session.assignedTo || ""}
            placeholder="Assign to email..."
            className="w-44 px-3 py-1.5 text-xs font-medium border border-brand-border rounded-xl outline-none focus:border-primary transition-colors bg-white text-brand-dark placeholder:text-brand-gray/40"
          />
          <button
            type="submit"
            className="text-[10px] font-black text-primary hover:underline uppercase tracking-widest"
          >
            Save
          </button>
        </fetcher.Form>
      </div>

      {/* Messages Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-10 space-y-8 bg-zinc-50/30">
        {localMessages.map((msg: any) => (
          <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-start' : 'justify-end'}`}>
            <div className="max-w-[70%] group">
              <div className={`p-4 rounded-3xl text-sm leading-relaxed ${
                msg.role === 'user' 
                  ? 'bg-white border border-zinc-100 text-zinc-800 rounded-bl-none shadow-sm' 
                  : 'bg-primary text-white rounded-br-none shadow-lg shadow-primary/10'
              }`}>
                {msg.content}
              </div>
              <p className={`text-[10px] mt-2 font-bold text-zinc-300 ${msg.role === 'user' ? 'text-left' : 'text-right'}`}>
                {format(new Date(msg.createdAt), "MMM d, h:mm a")}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* Reply Area */}
      <div className="p-6 bg-white border-t border-zinc-50">
        {session.mode === 'human' ? (
          <div>
            <div className="relative mb-3">
              <div className="flex items-center justify-between gap-3 mb-2">
                <button
                  type="button"
                  onClick={() => setShowCanned((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-primary hover:bg-primary/5 px-2.5 py-1.5 rounded-lg transition-colors"
                >
                  <MessageSquareText className="w-3.5 h-3.5" />
                  Canned replies
                  {cannedResponses.length > 0 && (
                    <span className="text-zinc-400 normal-case tracking-normal font-bold">({cannedResponses.length})</span>
                  )}
                </button>
                <Link
                  to={`/dashboard/projects/${session.project.id}/canned-responses`}
                  className="text-[10px] font-bold text-zinc-400 hover:text-primary uppercase tracking-wider"
                >
                  Manage →
                </Link>
              </div>
              {showCanned && (
                <div className="mb-3 max-h-48 overflow-y-auto rounded-2xl border border-zinc-100 bg-zinc-50 p-2 space-y-1">
                  {cannedResponses.length === 0 ? (
                    <p className="text-xs text-zinc-500 px-2 py-3">
                      No canned replies yet.{" "}
                      <Link to={`/dashboard/projects/${session.project.id}/canned-responses`} className="text-primary font-bold hover:underline">
                        Create one
                      </Link>
                    </p>
                  ) : (
                    cannedResponses.map((cr) => (
                      <button
                        key={cr.id}
                        type="button"
                        onClick={() => insertCanned(cr.body)}
                        className="w-full text-left px-3 py-2 rounded-xl hover:bg-white border border-transparent hover:border-zinc-100 transition-all"
                      >
                        <p className="text-xs font-black text-brand-dark">{cr.title}</p>
                        <p className="text-[11px] text-zinc-500 line-clamp-2 mt-0.5">{cr.body}</p>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <form ref={formRef as any} onSubmit={handleAgentReplySubmit} className="relative">
              <textarea 
                ref={replyTextareaRef}
                name="content" 
                placeholder="Type your live response to the visitor..." 
                rows={3}
                required
                className="w-full px-5 py-4 bg-zinc-50 border border-zinc-100 rounded-2xl focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none pr-20 text-sm font-medium"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
              ></textarea>
              <button 
                type="submit" 
                disabled={isSending}
                className="absolute bottom-4 right-4 p-3 bg-primary text-white rounded-xl shadow-lg shadow-primary/30 hover:scale-105 active:scale-95 transition-all disabled:opacity-50 cursor-pointer"
              >
                {isSending ? <Clock className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
              </button>
            </form>
            
            <div className="flex items-center justify-between mt-4">
              <p className="text-[10px] text-zinc-400 font-bold tracking-widest uppercase">
                🔴 You are manually responding • Live chat active
              </p>
              
              <button
                type="button"
                onClick={handleResolveSession}
                disabled={resolveFetcher.state !== "idle"}
                className="text-xs bg-emerald-50 text-emerald-800 border border-emerald-100 hover:bg-emerald-100 font-black uppercase tracking-wider py-1.5 px-3 rounded-lg transition-all flex items-center gap-1 cursor-pointer"
              >
                Resolve & Hand Back to AI
              </button>
            </div>
          </div>
        ) : (
          <div className="p-8 bg-zinc-50 border border-zinc-100 rounded-2xl text-center">
            <Bot className="w-8 h-8 text-primary mx-auto mb-3 animate-pulse" />
            <h3 className="font-bold text-sm text-zinc-800 mb-1">AI Assistant is handling this chat</h3>
            <p className="text-xs text-text-muted mb-4 max-w-md mx-auto">The chatbot is responding to user questions automatically using your knowledge sources.</p>
            <Form method="post" className="inline-block">
              <input type="hidden" name="_action" value="toggle_mode" />
              <button 
                type="submit"
                className="px-5 py-2.5 bg-primary text-white rounded-xl text-xs font-black uppercase tracking-widest hover:scale-105 active:scale-95 transition-all shadow-md shadow-primary/10 flex items-center gap-2 cursor-pointer"
              >
                <User className="w-3.5 h-3.5" /> Enable Live Takeover
              </button>
            </Form>
          </div>
        )}
      </div>
    </div>
  );
}
