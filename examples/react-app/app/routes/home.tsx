import type { DH2DSession } from "mtai";
import type { Route } from "./+types/home";
import { useEffect, useRef, useState } from "react";
import { DH2D } from "~/dh2d";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "New React Router App" },
    { name: "description", content: "Welcome to React Router!" },
  ];
}

export default function Home() {
  const sessionRef = useRef<DH2DSession | null>(null)
  const [status, setStatus] = useState("sleeping")
  const [botText, setBotText] = useState("")
  const [asrText, setAsrText] = useState("")
  const [start, setStart] = useState(false)
  const [videoId, setVideoId] = useState("liruyun")

  useEffect(() => {
    if (status != "talking") setBotText("")
    if (status != "listening") setAsrText("")
  }, [status])
  return <div
  style={{
    width: "100%",
    height: "100%",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
  }}
  >
    {!start && (
      <button 
        onClick={() => setStart(true)}
        style={{
          padding: "15px 30px",
          fontSize: "18px",
          backgroundColor: "#4CAF50",
          color: "white",
          border: "none",
          borderRadius: "5px",
          cursor: "pointer",
          boxShadow: "0 4px 8px rgba(0,0,0,0.2)"
        }}
      >
        Click to Start
      </button>
    )}
    {start && <DH2D 
      sessionRef={sessionRef}
      asrKey=" " 
      videoId={videoId}
      style={{
        width: "100%",
        height: "100%",
        position: "absolute",
        top: 0,
        left: 0,
      }}
      onAsrOutput={setAsrText}
      onBotOutput={_ => setBotText(prev => prev + _)}
      onStatusChanged={setStatus}
    />}
    <div style={{
      backgroundColor: "white", 
      padding: "15px", 
      borderRadius: "5px", 
      position: "absolute", 
      bottom: "10px", 
      left: "10px",
      boxShadow: "0 4px 8px rgba(0,0,0,0.2)",
      fontSize: "16px"
    }}>
      <div style={{ marginBottom: "15px" }}>
        <label htmlFor="videoId" style={{ marginRight: "10px", fontWeight: "500" }}>Select Character:</label>
        <select 
          id="videoId" 
          value={videoId} 
          onChange={(e) => setVideoId(e.target.value)}
          style={{ 
            padding: "8px 12px", 
            borderRadius: "5px",
            border: "1px solid #ccc",
            backgroundColor: "#f8f8f8",
            cursor: "pointer"
          }}
        >
          <option value="liruyun">Liruyun</option>
          <option value="aigc_20250212">AIGC</option>
        </select>
      </div>
      <div style={{ lineHeight: "1.5" }}>
        <div><strong>Status:</strong> {status}</div>
        <div><strong>Bot Text:</strong> {botText}</div>
        <div><strong>ASR Text:</strong> {asrText}</div>
      </div>
      <div style={{ marginTop: "15px" }}>
        <button 
          onClick={() => sessionRef.current?.send({type: "wakeup"})} 
          style={{ 
            padding: "8px 16px", 
            backgroundColor: "#28a745", 
            color: "white", 
            border: "none", 
            borderRadius: "5px", 
            cursor: "pointer",
            fontWeight: "500",
            boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
            marginRight: "10px"
          }}
          disabled={!start || status !== "sleeping"}
        >
          Wake Up
        </button>
      </div>
      <div style={{ marginTop: "15px" }}>
        <button 
          onClick={() => sessionRef.current?.close()} 
          style={{ 
            padding: "8px 16px", 
            backgroundColor: "#dc3545", 
            color: "white", 
            border: "none", 
            borderRadius: "5px", 
            cursor: "pointer",
            fontWeight: "500",
            boxShadow: "0 2px 4px rgba(0,0,0,0.2)"
          }}
          disabled={!start}
        >
          Stop Session
        </button>
      </div>
    </div>
  </div>
}
