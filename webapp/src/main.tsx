import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import App from "@/App"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ChatProvider } from "@/state/chat"
import { ConsoleProvider } from "@/state/console"
import { InstrumentationProvider } from "@/state/instrumentation"
import "./index.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider delayDuration={400}>
      <ConsoleProvider>
        {/* Chat and Instrumentation talk to the real backend; both nest inside
            the console so their screens can still drive navigation, and so the
            "Ask about it" handoff can reach Chat from a finished run. */}
        <ChatProvider>
          <InstrumentationProvider>
            <App />
          </InstrumentationProvider>
        </ChatProvider>
        <Toaster
          position="bottom-right"
          offset={20}
          duration={4200}
          toastOptions={{
            unstyled: true,
            classNames: {
              // `!w-fit` beats sonner's fixed `width: var(--width)` — the
              // design's toast hugs its text.
              toast:
                "flex !w-fit animate-fade-up-sm items-center gap-[9px] rounded-[10px] bg-zinc-900 px-4 py-[11px] text-[12.5px] whitespace-nowrap text-white shadow-[0_8px_24px_rgba(0,0,0,.18)]",
              icon: "flex text-base text-green-400",
            },
          }}
          icons={{
            // the prototype confirms with a green ti-circle-check
            success: <i aria-hidden="true" className="ti ti-circle-check" />,
          }}
        />
      </ConsoleProvider>
    </TooltipProvider>
  </StrictMode>
)
