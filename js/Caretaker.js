// js/Caretaker.js - Caretaker Dashboard Logic

const SUPABASE_URL = localStorage.getItem('supabase_url') || 'https://placeholder.sb.co';
const SUPABASE_KEY = localStorage.getItem('supabase_key') || 'dummy_key';
const sb = window.sb.createClient(SUPABASE_URL, SUPABASE_KEY);

let caretakerUser = null;
let linkedUser = null;
let pc = null;
let currentSOSId = null;

const wsHost = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
const wsUrl = `${wsHost}${window.location.host}/ws`;
const webrtcWs = new WebSocket(wsUrl);

async function initCaretaker() {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return window.location.href = '/login.html';
    caretakerUser = user;
    
    // Check pending links
    await fetchPendingLinks();
    
    // Load linked user profile
    await fetchLinkedUser();
    
    // Subscribe Realtime SOS
    sb.channel('sos_events')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sos_events', filter: `caretaker_id=eq.${caretakerUser.id}` }, payload => {
            if (payload.new.status === 'active') showSOSAlert(payload.new);
        })
        .subscribe();
}

async function fetchPendingLinks() {
    const { data } = await sb.from('caretaker_links').select('*, profiles!user_id(full_name)').eq('caretaker_id', caretakerUser.id).eq('status', 'pending');
    
    const list = document.getElementById('requests-list');
    list.innerHTML = '';
    
    if (data.length > 0) {
        document.getElementById('pending-requests').classList.remove('hidden');
        data.forEach(link => {
            const li = document.createElement('li');
            li.innerHTML = `${link.profiles.full_name} wants to link <button onclick="acceptLink('${link.id}')">Accept</button>`;
            list.appendChild(li);
        });
    }
}

async function acceptLink(id) {
    await sb.from('caretaker_links').update({ status: 'accepted' }).eq('id', id);
    document.getElementById('pending-requests').classList.add('hidden');
    await fetchLinkedUser();
}

async function fetchLinkedUser() {
    const { data: links } = await sb.from('caretaker_links').select('*, profiles!user_id(*)').eq('caretaker_id', caretakerUser.id).eq('status', 'accepted').single();
    
    const details = document.getElementById('user-details');
    if (links) {
        linkedUser = links.profiles;
        details.innerHTML = `<h3>${linkedUser.full_name}</h3><p>Last Seen: ${new Date(linkedUser.last_seen).toLocaleString()}</p>`;
        
        // ping realtime
        setInterval(async () => {
            const { data: userProfile } = await sb.from('profiles').select('is_online, last_seen').eq('id', linkedUser.id).single();
            const ind = document.getElementById('online-indicator');
            const now = new Date();
            const seen = new Date(userProfile.last_seen);
            if (userProfile.is_online && (now - seen < 60000)) {
                ind.innerHTML = '<span class="status-online">● Online</span>';
            } else {
                ind.innerHTML = '<span class="status-offline">○ Offline</span>';
            }
        }, 15000);
        
    } else {
        details.innerHTML = 'No user linked yet.';
    }
}

function showSOSAlert(sosEvent) {
    currentSOSId = sosEvent.id;
    const sect = document.getElementById('sos-alert-section');
    sect.classList.remove('hidden');
    document.getElementById('sos-message').innerText = `CRITICAL ALERT FROM LINKED USER ID: ${sosEvent.user_id}`;
    document.getElementById('sos-location').innerHTML = `Location: <a href="https://maps.google.com/?q=${sosEvent.latitude},${sosEvent.longitude}" target="_blank">View Map</a>`;
    document.getElementById('sos-sensors').innerText = `Sensors: Ultrasonic ${sosEvent.sensor_snapshot.ultrasonicCm}cm, Motion: ${sosEvent.sensor_snapshot.pirMotion}`;
    
    // Play alert
    const audio = new Audio('/sos_alert.mp3'); // Placeholder for sound
    audio.play().catch(e=>console.warn("Audio autoplay blocked", e));
}

async function resolveSOS() {
    if(!currentSOSId) return;
    await sb.from('sos_events').update({ status: 'resolved' }).eq('id', currentSOSId);
    document.getElementById('sos-alert-section').classList.add('hidden');
    currentSOSId = null;
    pc?.close();
}

let incomingOffer = null;
let incomingUserId = null;

webrtcWs.onmessage = async (msg) => {
    const data = JSON.parse(msg.data);
    if (data.type === 'webrtc_offer') {
        incomingOffer = data.sdp;
        incomingUserId = data.from;
    } else if (data.type === 'webrtc_ice_candidate' && pc) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
};

async function answerWebRTCCall() {
    if (!incomingOffer) return alert("No incoming call found");
    
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    const localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.ontrack = e => {
        const audio = document.getElementById('remoteAudio');
        if (audio.srcObject !== e.streams[0]) {
            audio.srcObject = e.streams[0];
            audio.play();
        }
    };

    pc.onicecandidate = e => {
        if (e.candidate) webrtcWs.send(JSON.stringify({ type: 'webrtc_ice_candidate', to: incomingUserId, candidate: e.candidate }));
    };

    await pc.setRemoteDescription(new RTCSessionDescription(incomingOffer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    webrtcWs.send(JSON.stringify({ type: 'webrtc_answer', from: caretakerUser.id, to: incomingUserId, sdp: pc.localDescription }));
}

function logout() {
    sb.auth.signOut().then(() => window.location.href='/login.html');
}

window.onload = initCaretaker;