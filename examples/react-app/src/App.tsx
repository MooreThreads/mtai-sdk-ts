import { useState, useRef, useEffect } from 'react'
import type { DH2DSession, ComponentStatus, Avatar, Voice } from 'mtai'
import { getShareCode, observeComponents, updateComponent, cancelUpdateComponent, setShareCode, getLlmModels, getTtsVoices, getAvatars } from 'mtai'
import { DH2D } from './dh2d'
import './App.css'

interface ModalProps {
  isOpen: boolean;
  title: string;
  children: React.ReactNode;
}

const Modal: React.FC<ModalProps> = ({ isOpen, title, children }) => {
  if (!isOpen) return null;

  return (
    <div style={{
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(0,0,0,0.5)",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      boxSizing: "border-box",
      zIndex: 1000
    }}>
      <div style={{
        backgroundColor: "white",
        padding: "20px",
        borderRadius: "8px",
        width: "400px",
        maxWidth: "90%",
        maxHeight: "80vh",
        overflowY: "auto",
        boxSizing: "border-box"
      }}>
        <h3 style={{ marginTop: 0 }}>{title}</h3>
        {children}
      </div>
    </div>
  );
};

interface ShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  shareCode: string;
  onSetShareCode: (code: string) => void;
}

const ShareModal: React.FC<ShareModalProps> = ({ isOpen, onClose, shareCode, onSetShareCode }) => {
  const [newShareCode, setNewShareCode] = useState("");

  const handleSetShareCode = async () => {
    if (newShareCode) {
      await onSetShareCode(newShareCode);
      setNewShareCode("");
    }
  };

  return (
    <Modal isOpen={isOpen} title="Share Code">
      <div style={{ marginBottom: "15px" }}>
        <p><strong>Current Share Code:</strong> {shareCode}</p>
      </div>
      <div style={{ marginBottom: "15px" }}>
        <div style={{ display: "flex" }}>
          <input
            type="text"
            value={newShareCode}
            onChange={(e) => setNewShareCode(e.target.value)}
            placeholder="Enter new share code"
            style={{
              flex: 1,
              padding: "8px",
              borderRadius: "4px",
              border: "1px solid #ccc",
              marginBottom: "10px"
            }}
          />
        </div>
        <button
          onClick={handleSetShareCode}
          style={{
            padding: "8px 16px",
            backgroundColor: "#28a745",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
            marginRight: "10px"
          }}
        >
          Set New Code
        </button>
        <button
          onClick={onClose}
          style={{
            padding: "8px 16px",
            backgroundColor: "#6c757d",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer"
          }}
        >
          Close
        </button>
      </div>
    </Modal>
  );
};

interface ComponentsModalProps {
  isOpen: boolean;
  onClose: () => void;
  components: ComponentStatus[];
}

const ComponentsModal: React.FC<ComponentsModalProps> = ({ isOpen, onClose, components }) => {
  return (
    <Modal isOpen={isOpen} title="Components Status">
      <div style={{ marginBottom: "15px" }}>
        {components.map((component) => (
          <div key={component.component.name} style={{ 
            padding: "15px", 
            borderBottom: "1px solid #eee",
            backgroundColor: "#f8f9fa",
            borderRadius: "4px",
            marginBottom: "10px"
          }}>
            <div style={{ 
              display: "flex", 
              justifyContent: "space-between", 
              alignItems: "center",
              marginBottom: "8px"
            }}>
              <div>
                <h4 style={{ margin: "0 0 4px 0", color: "#2c3e50" }}>{component.component.name}</h4>
                {component.component.description && (
                  <p style={{ margin: "0", color: "#666", fontSize: "14px" }}>{component.component.description}</p>
                )}
              </div>
              <div style={{ 
                padding: "4px 8px",
                borderRadius: "4px",
                backgroundColor: component.download?.status === "completed" ? "#28a745" : 
                               component.download?.status === "failed" ? "#dc3545" :
                               component.download?.status === "running" ? "#007bff" : "#ffc107",
                color: "white",
                fontSize: "14px",
                fontWeight: "500"
              }}>
                {component.download?.status}
              </div>
            </div>
            
            <div style={{ 
              display: "grid", 
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", 
              gap: "10px",
              fontSize: "14px"
            }}>
              {component.local_version && (
                <div>
                  <strong>Local Version:</strong> {component.local_version}
                </div>
              )}
              {component.component.version && (
                <div>
                  <strong>Version:</strong> {component.component.version}
                </div>
              )}
              {component.component.category && (
                <div>
                  <strong>Category:</strong> {component.component.category}
                </div>
              )}
              {component.download?.progress !== undefined && (
                <div>
                  <strong>Progress:</strong> {Math.round(component.download.progress * 100)}%
                </div>
              )}
            </div>

            {component.download?.error && (
              <div style={{ 
                marginTop: "8px", 
                padding: "8px",
                backgroundColor: "#f8d7da",
                color: "#721c24",
                borderRadius: "4px",
                fontSize: "14px"
              }}>
                <strong>Error:</strong> {component.download.error}
              </div>
            )}

            <div style={{ 
              marginTop: "12px",
              display: "flex",
              gap: "8px"
            }}>
              <button
                onClick={() => updateComponent(component.component.name)}
                disabled={component.download?.status === "running"}
                style={{
                  padding: "6px 12px",
                  backgroundColor: component.download?.status === "running" ? "#6c757d" : "#28a745",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: component.download?.status === "running" ? "not-allowed" : "pointer",
                  fontSize: "14px",
                  opacity: component.download?.status === "running" ? 0.7 : 1
                }}
              >
                Update
              </button>
              <button
                onClick={() => cancelUpdateComponent(component.component.name)}
                disabled={component.download?.status !== "running"}
                style={{
                  padding: "6px 12px",
                  backgroundColor: component.download?.status === "running" ? "#dc3545" : "#6c757d",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: component.download?.status === "running" ? "pointer" : "not-allowed",
                  fontSize: "14px",
                  opacity: component.download?.status === "running" ? 1 : 0.7
                }}
              >
                Cancel Update
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={onClose}
        style={{
          padding: "8px 16px",
          backgroundColor: "#6c757d",
          color: "white",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer"
        }}
      >
        Close
      </button>
    </Modal>
  );
};

interface ListModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  items: { id: string; name: string; description?: string }[];
}

const ListModal: React.FC<ListModalProps> = ({ isOpen, onClose, title, items }) => {
  return (
    <Modal isOpen={isOpen} title={title}>
      <div style={{ marginBottom: "15px" }}>
        {items.map((item) => (
          <div key={item.id} style={{ 
            padding: "12px", 
            borderBottom: "1px solid #eee",
            backgroundColor: "#f8f9fa",
            borderRadius: "4px",
            marginBottom: "8px"
          }}>
            <div style={{ 
              display: "flex", 
              justifyContent: "space-between", 
              alignItems: "center"
            }}>
              <div>
                <h4 style={{ margin: "0 0 4px 0", color: "#2c3e50" }}>{item.name}</h4>
                {item.description && (
                  <p style={{ margin: "0", color: "#666", fontSize: "14px" }}>{item.description}</p>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={onClose}
        style={{
          padding: "8px 16px",
          backgroundColor: "#6c757d",
          color: "white",
          border: "none",
          borderRadius: "4px",
          cursor: "pointer"
        }}
      >
        Close
      </button>
    </Modal>
  );
};

export default function App() {
  const sessionRef = useRef<DH2DSession | null>(null)
  const [status, setStatus] = useState("sleeping")
  const [botText, setBotText] = useState("")
  const [asrText, setAsrText] = useState("")
  const [start, setStart] = useState(false)
  const [videoId, setVideoId] = useState("liruyun")
  const [showShareModal, setShowShareModal] = useState(false)
  const [showComponentsModal, setShowComponentsModal] = useState(false)
  const [shareCode, setShareCodeState] = useState("")
  const [components, setComponents] = useState<ComponentStatus[]>([])
  const [showLlmModelsModal, setShowLlmModelsModal] = useState(false)
  const [showTtsVoicesModal, setShowTtsVoicesModal] = useState(false)
  const [llmModels, setLlmModels] = useState<any[]>([])
  const [ttsVoices, setTtsVoices] = useState<Voice[]>([])
  const [avatars, setAvatars] = useState<Avatar[]>([])

  useEffect(() => observeComponents(setComponents), []);
  useEffect(() => {
    if (status != "talking") setBotText("")
    if (status != "listening") setAsrText("")
  }, [status])

  const fetchLlmModels = async () => {
    const models = await getLlmModels();
    console.log('Models:', models);
    setLlmModels(models);
  };

  const fetchTtsVoices = async () => {
    const voices = await getTtsVoices();
    console.log('Voices:', voices);
    setTtsVoices(voices);
  };

  const fetchAvatars = async () => {
    const avatars = await getAvatars();
    console.log('Avatars:', avatars);
    setAvatars(avatars);
  };

  useEffect(() => {
    const fetchData = async () => {
      await Promise.all([
        fetchLlmModels(),
        fetchTtsVoices(),
        fetchAvatars()
      ]);
    };
    fetchData();
  }, []);

  const handleShareCodeClick = async () => {
    console.log("getShareCode")
    const code = await getShareCode()
    setShareCodeState(code)
    setShowShareModal(true)
  }

  const handleSetShareCode = async (newCode: string) => {
    await setShareCode(newCode)
    setShareCodeState(newCode)
  }

  return (
    <div style={{
      width: "100%",
      height: "100%",
      display: "flex",
      justifyContent: "center",
      alignItems: "center",
      position: "relative",
    }}>
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
            {avatars.map(a => <option value={a.id}>{a.title || a.id}</option>)}
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
          <button 
            onClick={handleShareCodeClick}
            style={{ 
              padding: "8px 16px", 
              backgroundColor: "#007bff", 
              color: "white", 
              border: "none", 
              borderRadius: "5px", 
              cursor: "pointer",
              fontWeight: "500",
              boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
              marginRight: "10px"
            }}
          >
            Share Code
          </button>
          <button 
            onClick={() => setShowComponentsModal(true)}
            style={{ 
              padding: "8px 16px", 
              backgroundColor: "#6f42c1", 
              color: "white", 
              border: "none", 
              borderRadius: "5px", 
              cursor: "pointer",
              fontWeight: "500",
              boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
              marginRight: "10px"
            }}
          >
            Components
          </button>
          <button 
            onClick={async () => {
              await fetchLlmModels();
              setShowLlmModelsModal(true);
            }}
            style={{ 
              padding: "8px 16px", 
              backgroundColor: "#20c997", 
              color: "white", 
              border: "none", 
              borderRadius: "5px", 
              cursor: "pointer",
              fontWeight: "500",
              boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
              marginRight: "10px"
            }}
          >
            LLM Models
          </button>
          <button 
            onClick={async () => {
              await fetchTtsVoices();
              setShowTtsVoicesModal(true);
            }}
            style={{ 
              padding: "8px 16px", 
              backgroundColor: "#fd7e14", 
              color: "white", 
              border: "none", 
              borderRadius: "5px", 
              cursor: "pointer",
              fontWeight: "500",
              boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
              marginRight: "10px"
            }}
          >
            TTS Voices
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

      <ShareModal 
        isOpen={showShareModal}
        onClose={() => setShowShareModal(false)}
        shareCode={shareCode}
        onSetShareCode={handleSetShareCode}
      />

      <ComponentsModal
        isOpen={showComponentsModal}
        onClose={() => setShowComponentsModal(false)}
        components={components}
      />

      <ListModal
        isOpen={showLlmModelsModal}
        onClose={() => setShowLlmModelsModal(false)}
        title="LLM Models"
        items={llmModels.map(model => ({
          id: model.title,
          name: model.title,
          description: model.description
        }))}
      />

      <ListModal
        isOpen={showTtsVoicesModal}
        onClose={() => setShowTtsVoicesModal(false)}
        title="TTS Voices"
        items={ttsVoices.map(voice => ({
          id: voice.code,
          name: voice.display_name || voice.code,
          description: voice.description
        }))}
      />
    </div>
  );
}
