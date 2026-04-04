// js/SOS.js - User Side WebRTC / SOS Logic

const SUPABASE_URL = localStorage.getItem('supabase_url') || 'https://placeholder.supabase.co';
const SUPABASE_KEY = localStorage.getItem('supabase_key') || 'dummy_key';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let pc = null;
let localStream = null;
let currentCaretakerId = null;
let sosEventId = null;

const wsUrl = `wss://visionai-hig1.onrender.com/api/pi/ws`;
const webrtcWs = new WebSocket(wsUrl);

async function initSOS() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) {
        window.location.replace('/login.html');
        return;
    }

    // Load active caretaker
    const { data: links } = await sb.from('caretaker_links').select('*').eq('user_id', user.id).eq('status', 'accepted').single();
    if (links) currentCaretakerId = links.caretaker_id;

    // Realtime Ping
    setInterval(() => {
        sb.from('profiles').update({ is_online: true, last_seen: new Date().toISOString() }).eq('id', user.id).then();
    }, 30000);
}

window.addEventListener('beforeunload', () => {
    sb.auth.getUser().then(({data}) => {
        if(data.user) sb.from('profiles').update({ is_online: false }).eq('id', data.user.id).then();
    });
});

async function triggerSOS() {
    if (!currentCaretakerId) {
        alert("No caretaker linked! Please set one up in Settings.");
        return;
    }

    const user = (await sb.auth.getUser()).data.user;
    if (!user) return;

    // Build Payload
    const ultrasonicCm = window.getUltrasonicDist ? window.getUltrasonicDist() : 0;
    const pirMotion = window.getPIRStatus ? window.getPIRStatus() : false;
    
    // Get Geolocation
    navigator.geolocation.getCurrentPosition(async (pos) => {
        const { latitude, longitude } = pos.coords;
        
        // Insert DB Record
        const { data, error } = await sb.from('sos_events').insert([{
            user_id: user.id,
            caretaker_id: currentCaretakerId,
            latitude,
            longitude,
            sensor_snapshot: { ultrasonicCm, pirMotion },
            status: 'active'
        }]).select().single();
        
        if (data) {
            sosEventId = data.id;
            showSOSOverlay();
            startWebRTCOffer();
        }
    }, (err) => {
        console.error("GPS Failed for SOS", err);
        alert("SOS triggered but Location failed.");
    });
}

function showSOSOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'sos-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(255,0,0,0.8);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;color:white;';
    overlay.innerHTML = `
        <h1 style="font-size:3rem;animation:pulse 1s infinite alternate;">SOS ACTIVE</h1>
        <p>Connecting to caretaker...</p>
        <button onclick="cancelSOS()" style="padding:15px 30px;background:#333;color:#fff;border:none;border-radius:8px;margin-top:20px;">Cancel SOS</button>
    `;
    document.body.appendChild(overlay);
}

async function cancelSOS() {
    document.getElementById('sos-overlay')?.remove();
    if (sosEventId) {
        await sb.from('sos_events').update({ status: 'resolved' }).eq('id', sosEventId);
    }
    if (pc) pc.close();
    if (localStream) localStream.getTracks().forEach(t => t.stop());
}

async function startWebRTCOffer() {
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.onicecandidate = e => {
        if (e.candidate) webrtcWs.send(JSON.stringify({ type: 'webrtc_ice_candidate', to: currentCaretakerId, candidate: e.candidate }));
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    // Forward signaling
    const user = (await sb.auth.getUser()).data.user;
    webrtcWs.send(JSON.stringify({ type: 'webrtc_offer', from: user.id, to: currentCaretakerId, sdp: pc.localDescription }));
}

webrtcWs.onmessage = async (msg) => {
    const data = JSON.parse(msg.data);
    if (!pc) return;
    if (data.type === 'webrtc_answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === 'webrtc_ice_candidate') {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
};

window.addEventListener('load', initSOS);