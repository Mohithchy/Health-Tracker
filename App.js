import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, Modal, TextInput,
  StyleSheet, Animated, Dimensions, StatusBar,
  SafeAreaView, Vibration,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Audio } from "expo-av";

// ─────────────────────────────────────────────────────────────
// 🎵  SOUND ENGINE  (no expo-file-system — works in Snack!)
// Generates WAV tones in pure JS, encodes as base64 data URI,
// plays directly via expo-av. Zero external files needed.
// ─────────────────────────────────────────────────────────────
const SAMPLE_RATE = 22050;

function buildWavDataUri(notes) {
  const totalSamples = notes.reduce((a, n) => a + Math.floor(SAMPLE_RATE * n.duration), 0);
  const dataBytes    = totalSamples * 2;
  const buf          = new ArrayBuffer(44 + dataBytes);
  const v            = new DataView(buf);

  // RIFF header
  const enc = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  enc(0, "RIFF"); v.setUint32(4, 36 + dataBytes, true); enc(8, "WAVE");
  enc(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  enc(36, "data"); v.setUint32(40, dataBytes, true);

  // PCM samples
  let offset = 44;
  for (const { freq, duration, volume = 0.6, wave = "sine", decay = 6 } of notes) {
    const n = Math.floor(SAMPLE_RATE * duration);
    for (let i = 0; i < n; i++) {
      const t   = i / SAMPLE_RATE;
      const env = Math.exp(-t * decay);
      let s = wave === "triangle"
        ? (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * freq * t))
        : Math.sin(2 * Math.PI * freq * t);
      v.setInt16(offset, Math.round(s * env * volume * 32767), true);
      offset += 2;
    }
  }

  // base64 encode
  const bytes = new Uint8Array(buf);
  let binary  = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return "data:audio/wav;base64," + btoa(binary);
}

// Pre-build all data URIs (runs once, synchronously — fast)
const SOUNDS = {
  check:   buildWavDataUri([
    { freq: 1047, duration: 0.04, volume: 0.55, wave: "sine",     decay: 18 },
    { freq: 1319, duration: 0.14, volume: 0.50, wave: "triangle", decay: 9  },
  ]),
  uncheck: buildWavDataUri([
    { freq: 440, duration: 0.06, volume: 0.35, wave: "sine", decay: 22 },
    { freq: 330, duration: 0.10, volume: 0.28, wave: "sine", decay: 14 },
  ]),
  add:     buildWavDataUri([
    { freq: 523,  duration: 0.07, volume: 0.45, wave: "triangle", decay: 20 },
    { freq: 659,  duration: 0.07, volume: 0.45, wave: "triangle", decay: 20 },
    { freq: 784,  duration: 0.07, volume: 0.45, wave: "triangle", decay: 20 },
    { freq: 1047, duration: 0.14, volume: 0.50, wave: "sine",     decay: 8  },
  ]),
  allDone: buildWavDataUri([
    { freq: 523,  duration: 0.12, volume: 0.55, wave: "sine",     decay: 6 },
    { freq: 659,  duration: 0.12, volume: 0.55, wave: "sine",     decay: 6 },
    { freq: 784,  duration: 0.12, volume: 0.55, wave: "triangle", decay: 6 },
    { freq: 1047, duration: 0.28, volume: 0.60, wave: "sine",     decay: 4 },
  ]),
  del:     buildWavDataUri([
    { freq: 180, duration: 0.12, volume: 0.40, wave: "sine", decay: 18 },
  ]),
};

async function playSound(key) {
  try {
    await Audio.setAudioModeAsync({ playsInSilentModeIOS: true });
    const { sound } = await Audio.Sound.createAsync(
      { uri: SOUNDS[key] },
      { shouldPlay: true, volume: 1.0 }
    );
    sound.setOnPlaybackStatusUpdate(s => { if (s.didJustFinish) sound.unloadAsync(); });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────
const DAYS   = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const ICONS  = ["🌅","📖","🏃","💧","✍️","🧘","🥗","💪","🎨","🎵","🌿","☀️","🌙","🦷","🧠","🎯","🚀","🎧","🛌","🥑"];
const COLORS = ["#FF6B6B","#4ECDC4","#FFE66D","#6BB5FF","#C084FC","#FF9F43","#26de81","#fd79a8","#74b9ff","#a29bfe"];
const QUOTES = [
  "Small steps every day lead to giant leaps over time.",
  "Discipline is choosing between what you want now and what you want most.",
  "You don't rise to the level of your goals, you fall to your systems.",
  "Every action is a vote for the person you want to become.",
];
const DEFAULT_HABITS = [
  { id:1, name:"Morning Meditation", icon:"🌅", color:"#FF6B6B", completions:[true,true,false,true,true,false,false] },
  { id:2, name:"Read 30 Minutes",    icon:"📖", color:"#4ECDC4", completions:[true,false,true,true,false,true,false] },
  { id:3, name:"Exercise",           icon:"🏃", color:"#FFE66D", completions:[false,true,true,false,true,false,false] },
  { id:4, name:"Drink Water",        icon:"💧", color:"#6BB5FF", completions:[true,true,true,false,true,true,false] },
  { id:5, name:"Journal Entry",      icon:"✍️", color:"#C084FC", completions:[false,false,true,true,true,false,false] },
];

const todayIndex = new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;
let nextId = 100;
const { width: SW } = Dimensions.get("window");
const CELL = Math.floor((SW - 40 - 140 - 30) / 7);

const C = {
  bg:"#0D0D14", card:"#15161F", card2:"#1C1D2A",
  border:"rgba(255,255,255,0.08)", text:"#F0EEF8",
  muted:"rgba(240,238,248,0.45)",
};

// ─────────────────────────────────────────────────────────────
// CheckCell
// ─────────────────────────────────────────────────────────────
function CheckCell({ done, color, isToday, onPress }) {
  const scale  = useRef(new Animated.Value(done ? 1 : 0)).current;
  const bounce = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    Animated.spring(scale, {
      toValue: done ? 1 : 0,
      useNativeDriver: true, damping: 12, stiffness: 200,
    }).start();
  }, [done]);

  const handlePress = () => {
    Animated.sequence([
      Animated.timing(bounce, { toValue: 0.78, duration: 70, useNativeDriver: true }),
      Animated.spring(bounce,  { toValue: 1, damping: 7, stiffness: 280, useNativeDriver: true }),
    ]).start();
    if (!done) {
      Vibration.vibrate([0, 25]);
      playSound("check");
    } else {
      Vibration.vibrate(10);
      playSound("uncheck");
    }
    onPress();
  };

  return (
    <TouchableOpacity activeOpacity={0.85} onPress={handlePress}>
      <Animated.View style={[
        styles.checkCell,
        isToday && styles.checkCellToday,
        { width: CELL, transform: [{ scale: bounce }] },
        done && { backgroundColor: color, borderWidth: 0,
          shadowColor: color, shadowOpacity: 0.6, shadowRadius: 12, elevation: 7 },
      ]}>
        <Animated.View style={{ transform: [{ scale }] }}>
          <Text style={styles.checkMark}>✓</Text>
        </Animated.View>
        {!done && <View style={[styles.emptyDot, { backgroundColor: color + "55" }]} />}
      </Animated.View>
    </TouchableOpacity>
  );
}

// ─────────────────────────────────────────────────────────────
// HabitRow
// ─────────────────────────────────────────────────────────────
function HabitRow({ habit, todayIdx, onToggle, onDelete }) {
  const slideIn = useRef(new Animated.Value(20)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slideIn, { toValue: 0, duration: 380, useNativeDriver: true }),
      Animated.timing(opacity,  { toValue: 1, duration: 380, useNativeDriver: true }),
    ]).start();
  }, []);

  const streak = (() => {
    let s = 0;
    for (let i = todayIdx; i >= 0; i--) { if (habit.completions[i]) s++; else break; }
    return s;
  })();

  return (
    <Animated.View style={[styles.habitRow, { opacity, transform: [{ translateY: slideIn }] }]}>
      <View style={[styles.habitInfo, { borderColor: habit.color + "33" }]}>
        <View style={[styles.iconBubble, { backgroundColor: habit.color + "28" }]}>
          <Text style={styles.iconEmoji}>{habit.icon}</Text>
        </View>
        <View style={styles.habitText}>
          <Text style={styles.habitName} numberOfLines={1}>{habit.name}</Text>
          {streak > 0 && (
            <View style={styles.streakPill}>
              <Text style={styles.streakText}>🔥 {streak} day streak</Text>
            </View>
          )}
        </View>
        <TouchableOpacity
          style={styles.delBtn}
          onPress={() => { playSound("del"); Vibration.vibrate(40); onDelete(habit.id); }}
          hitSlop={{top:10,bottom:10,left:10,right:10}}>
          <Text style={styles.delBtnText}>✕</Text>
        </TouchableOpacity>
      </View>
      {DAYS.map((_, di) => (
        <CheckCell
          key={di}
          done={habit.completions[di]}
          color={habit.color}
          isToday={di === todayIdx}
          onPress={() => onToggle(habit.id, di)}
        />
      ))}
    </Animated.View>
  );
}

// ─────────────────────────────────────────────────────────────
// AllDone Banner
// ─────────────────────────────────────────────────────────────
function AllDoneBanner({ visible }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(anim, {
      toValue: visible ? 1 : 0,
      useNativeDriver: true, damping: 14, stiffness: 160,
    }).start();
  }, [visible]);
  if (!visible) return null;
  return (
    <Animated.View style={[styles.allDoneBanner, { transform:[{ scale: anim }], opacity: anim }]}>
      <Text style={styles.allDoneText}>🎉 All done today! You're crushing it!</Text>
    </Animated.View>
  );
}

// ─────────────────────────────────────────────────────────────
// StatCard
// ─────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, accentColor }) {
  return (
    <View style={styles.statCard}>
      <View style={[styles.statAccent, { backgroundColor: accentColor }]} />
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statNum}>{value}<Text style={styles.statSub}>{sub}</Text></Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────
export default function App() {
  const [habits,   setHabits]   = useState(DEFAULT_HABITS);
  const [showAdd,  setShowAdd]  = useState(false);
  const [newName,  setNewName]  = useState("");
  const [newIcon,  setNewIcon]  = useState("🌿");
  const [newColor, setNewColor] = useState("#4ECDC4");
  const [quote] = useState(() => QUOTES[Math.floor(Math.random() * QUOTES.length)]);
  const prevTodayDone = useRef(0);

  // Persist
  useEffect(() => {
    AsyncStorage.getItem("habits").then(v => { if (v) setHabits(JSON.parse(v)); });
  }, []);
  useEffect(() => {
    AsyncStorage.setItem("habits", JSON.stringify(habits));
  }, [habits]);

  // Stats
  const todayDone    = habits.filter(h => h.completions[todayIndex]).length;
  const weekTotal    = habits.reduce((a, h) => a + h.completions.filter(Boolean).length, 0);
  const weekMax      = habits.length * 7;
  const weekPct      = weekMax ? Math.round((weekTotal / weekMax) * 100) : 0;
  const allDoneToday = habits.length > 0 && todayDone === habits.length;

  // All-done fanfare fires once when last habit checked
  useEffect(() => {
    if (allDoneToday && todayDone > prevTodayDone.current) {
      setTimeout(() => playSound("allDone"), 250);
      Vibration.vibrate([0, 40, 60, 80, 60, 120]);
    }
    prevTodayDone.current = todayDone;
  }, [todayDone, allDoneToday]);

  const toggle = useCallback((habitId, dayIdx) => {
    setHabits(h => h.map(x => {
      if (x.id !== habitId) return x;
      const c = [...x.completions]; c[dayIdx] = !c[dayIdx];
      return { ...x, completions: c };
    }));
  }, []);

  const addHabit = () => {
    if (!newName.trim()) return;
    setHabits(h => [...h, {
      id: nextId++, name: newName.trim(), icon: newIcon, color: newColor,
      completions: Array(7).fill(false),
    }]);
    playSound("add");
    Vibration.vibrate([0, 20, 30, 40]);
    setNewName(""); setShowAdd(false);
  };

  const removeHabit = useCallback((id) => setHabits(h => h.filter(x => x.id !== id)), []);

  const today = new Date().toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric" });

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 60 }}>

        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerTag}>
            <Text style={styles.headerTagText}>⚡ DAILY HABITS</Text>
          </View>
          <Text style={styles.headerTitle}>Level Up Your{"\n"}<Text style={styles.titleAccent}>Routines</Text></Text>
          <View style={styles.dateBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.dateBadgeText}>{today}</Text>
          </View>
        </View>

        {/* Quote */}
        <View style={styles.quoteStrip}>
          <Text style={styles.quoteText}>💬 {quote}</Text>
        </View>

        {/* All Done Banner */}
        <AllDoneBanner visible={allDoneToday} />

        {/* Stats */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.statsRow} contentContainerStyle={{ paddingRight: 20 }}>
          <StatCard label="Today"  value={todayDone} sub={`/${habits.length}`} accentColor="#FF6B6B" />
          <StatCard label="Weekly" value={weekPct}   sub="%"                   accentColor="#4ECDC4" />
          <StatCard label="Habits" value={habits.length}                        accentColor="#C084FC" />
        </ScrollView>

        {/* Week bar */}
        <View style={styles.weekBarWrap}>
          <View style={styles.weekBarLabel}>
            <Text style={styles.weekBarLabelText}>🔥 Weekly Progress</Text>
            <Text style={styles.weekBarLabelBold}>{weekTotal} / {weekMax}</Text>
          </View>
          <View style={styles.weekBarTrack}>
            <View style={[styles.weekBarFill, { width: weekMax > 0 ? `${weekPct}%` : "0%" }]} />
          </View>
        </View>

        {/* Section */}
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>This Week 📅</Text>
          <TouchableOpacity style={styles.addBtn} onPress={() => setShowAdd(true)} activeOpacity={0.85}>
            <Text style={styles.addBtnText}>＋ New Habit</Text>
          </TouchableOpacity>
        </View>

        {/* Day labels */}
        <View style={styles.dayHeaderRow}>
          <View style={{ width: 140 }} />
          {DAYS.map((d, i) => (
            <View key={d} style={{ width: CELL, alignItems: "center" }}>
              <Text style={[styles.dayLbl, i === todayIndex && styles.dayLblToday]}>{d}</Text>
            </View>
          ))}
        </View>

        {/* Habits */}
        {habits.map(habit => (
          <HabitRow
            key={habit.id} habit={habit} todayIdx={todayIndex}
            onToggle={toggle} onDelete={removeHabit}
          />
        ))}

        {habits.length === 0 && (
          <View style={styles.empty}>
            <Text style={{ fontSize: 52 }}>🚀</Text>
            <Text style={styles.emptyTitle}>No habits yet!</Text>
            <Text style={styles.emptySubtitle}>Hit "New Habit" to start your streak.</Text>
          </View>
        )}
      </ScrollView>

      {/* Add Modal */}
      <Modal visible={showAdd} transparent animationType="slide" onRequestClose={() => setShowAdd(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowAdd(false)}>
          <TouchableOpacity activeOpacity={1} style={styles.modal} onPress={() => {}}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>✨ New Habit</Text>

            <Text style={styles.formLabel}>NAME</Text>
            <TextInput
              style={styles.formInput}
              placeholder="e.g. Morning run..."
              placeholderTextColor={C.muted}
              value={newName}
              onChangeText={setNewName}
              onSubmitEditing={addHabit}
              returnKeyType="done"
              autoFocus
            />

            <Text style={styles.formLabel}>PICK AN ICON</Text>
            <View style={styles.iconGrid}>
              {ICONS.map(ic => (
                <TouchableOpacity key={ic}
                  style={[styles.iconBtn, newIcon === ic && styles.iconBtnSelected]}
                  onPress={() => setNewIcon(ic)}>
                  <Text style={{ fontSize: 22 }}>{ic}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Text style={styles.formLabel}>COLOR</Text>
            <View style={styles.colorRow}>
              {COLORS.map(col => (
                <TouchableOpacity key={col}
                  style={[styles.colorDot, { backgroundColor: col }, newColor === col && styles.colorDotSelected]}
                  onPress={() => setNewColor(col)} />
              ))}
            </View>

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.btnCancel} onPress={() => setShowAdd(false)}>
                <Text style={styles.btnCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnSave} onPress={addHabit}>
                <Text style={styles.btnSaveText}>Let's Go 🚀</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: C.bg },
  scroll: { flex: 1, backgroundColor: C.bg },

  header:         { paddingHorizontal: 20, paddingTop: 36, paddingBottom: 4 },
  headerTag:      { alignSelf: "flex-start", backgroundColor: "rgba(255,107,107,0.15)", borderWidth: 1, borderColor: "rgba(255,107,107,0.3)", borderRadius: 100, paddingHorizontal: 14, paddingVertical: 5, marginBottom: 14 },
  headerTagText:  { color: "#FF6B6B", fontSize: 11, fontWeight: "700", letterSpacing: 1.2 },
  headerTitle:    { fontSize: 36, fontWeight: "900", color: C.text, lineHeight: 42, letterSpacing: -0.5 },
  titleAccent:    { color: "#FF6B6B" },
  dateBadge:      { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 100, paddingHorizontal: 14, paddingVertical: 7, marginTop: 14, gap: 8 },
  liveDot:        { width: 7, height: 7, borderRadius: 4, backgroundColor: "#4ECDC4" },
  dateBadgeText:  { color: C.muted, fontSize: 12, fontWeight: "600" },

  quoteStrip:     { marginHorizontal: 20, marginTop: 18, padding: 16, backgroundColor: "rgba(255,230,109,0.08)", borderWidth: 1, borderColor: "rgba(255,230,109,0.2)", borderRadius: 16 },
  quoteText:      { color: "rgba(240,238,248,0.7)", fontSize: 13, fontWeight: "600", lineHeight: 20 },

  allDoneBanner:  { marginHorizontal: 20, marginTop: 14, padding: 16, backgroundColor: "rgba(78,205,196,0.15)", borderWidth: 1, borderColor: "rgba(78,205,196,0.4)", borderRadius: 16, alignItems: "center" },
  allDoneText:    { color: "#4ECDC4", fontSize: 15, fontWeight: "800" },

  statsRow:       { paddingLeft: 20, marginTop: 18 },
  statCard:       { width: 118, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 20, padding: 16, marginRight: 12, overflow: "hidden" },
  statAccent:     { position: "absolute", top: 0, left: 0, right: 0, height: 3, borderRadius: 20 },
  statLabel:      { color: C.muted, fontSize: 10, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase", marginTop: 4 },
  statNum:        { color: C.text, fontSize: 30, fontWeight: "700", marginTop: 4 },
  statSub:        { color: C.muted, fontSize: 14, fontWeight: "500" },

  weekBarWrap:      { paddingHorizontal: 20, marginTop: 18 },
  weekBarLabel:     { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  weekBarLabelText: { color: C.muted, fontSize: 12, fontWeight: "700" },
  weekBarLabelBold: { color: C.text, fontSize: 12, fontWeight: "800" },
  weekBarTrack:     { height: 8, backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 100, overflow: "hidden" },
  weekBarFill:      { height: "100%", backgroundColor: "#FF6B6B", borderRadius: 100 },

  sectionHeader:  { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, marginTop: 24 },
  sectionTitle:   { color: C.text, fontSize: 18, fontWeight: "900" },
  addBtn:         { backgroundColor: "#FF6B6B", borderRadius: 12, paddingHorizontal: 16, paddingVertical: 9, shadowColor: "#FF6B6B", shadowOpacity: 0.4, shadowRadius: 10, elevation: 5 },
  addBtnText:     { color: "white", fontSize: 13, fontWeight: "800" },

  dayHeaderRow:   { flexDirection: "row", paddingHorizontal: 20, marginTop: 14, marginBottom: 6, alignItems: "center" },
  dayLbl:         { color: C.muted, fontSize: 9, fontWeight: "800", letterSpacing: 0.8, textTransform: "uppercase", textAlign: "center" },
  dayLblToday:    { color: "#4ECDC4" },

  habitRow:       { flexDirection: "row", paddingHorizontal: 20, alignItems: "center", marginBottom: 8, gap: 4 },
  habitInfo:      { width: 140, flexDirection: "row", alignItems: "center", backgroundColor: C.card, borderWidth: 1, borderRadius: 16, overflow: "hidden" },
  iconBubble:     { width: 52, height: 56, alignItems: "center", justifyContent: "center" },
  iconEmoji:      { fontSize: 24 },
  habitText:      { flex: 1, paddingHorizontal: 8, paddingVertical: 6 },
  habitName:      { color: C.text, fontSize: 11, fontWeight: "800" },
  streakPill:     { backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 100, paddingHorizontal: 6, paddingVertical: 2, alignSelf: "flex-start", marginTop: 3 },
  streakText:     { color: "#FFE66D", fontSize: 9, fontWeight: "700" },
  delBtn:         { paddingHorizontal: 8, paddingVertical: 10 },
  delBtnText:     { color: C.muted, fontSize: 11 },

  checkCell:      { height: 56, borderRadius: 11, borderWidth: 2, borderColor: "rgba(255,255,255,0.1)", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.03)" },
  checkCellToday: { borderColor: "rgba(255,255,255,0.28)", backgroundColor: "rgba(255,255,255,0.06)" },
  checkMark:      { color: "white", fontSize: 18, fontWeight: "900", lineHeight: 22 },
  emptyDot:       { width: 5, height: 5, borderRadius: 3, position: "absolute" },

  empty:          { alignItems: "center", paddingVertical: 56, paddingHorizontal: 20 },
  emptyTitle:     { color: C.text, fontSize: 16, fontWeight: "800", marginTop: 12 },
  emptySubtitle:  { color: C.muted, fontSize: 13, marginTop: 6 },

  modalOverlay:    { flex: 1, backgroundColor: "rgba(0,0,0,0.75)", justifyContent: "flex-end" },
  modal:           { backgroundColor: C.card2, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 24, paddingBottom: 40, paddingTop: 16, maxHeight: "90%" },
  modalHandle:     { width: 40, height: 4, backgroundColor: "rgba(255,255,255,0.15)", borderRadius: 2, alignSelf: "center", marginBottom: 20 },
  modalTitle:      { color: C.text, fontSize: 22, fontWeight: "900", marginBottom: 20 },
  formLabel:       { color: C.muted, fontSize: 10, fontWeight: "800", letterSpacing: 1.2, marginBottom: 8 },
  formInput:       { backgroundColor: C.card, borderWidth: 2, borderColor: C.border, borderRadius: 14, padding: 14, color: C.text, fontSize: 16, fontWeight: "600", marginBottom: 18 },
  iconGrid:        { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 18 },
  iconBtn:         { width: 48, height: 48, borderRadius: 14, backgroundColor: C.card, borderWidth: 2, borderColor: "transparent", alignItems: "center", justifyContent: "center" },
  iconBtnSelected: { borderColor: "#4ECDC4", backgroundColor: "rgba(78,205,196,0.12)" },
  colorRow:        { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 24 },
  colorDot:        { width: 34, height: 34, borderRadius: 17, borderWidth: 3, borderColor: "transparent" },
  colorDotSelected:{ borderColor: "white" },
  modalActions:    { flexDirection: "row", gap: 10 },
  btnCancel:       { flex: 1, borderWidth: 2, borderColor: C.border, borderRadius: 14, padding: 14, alignItems: "center" },
  btnCancelText:   { color: C.muted, fontSize: 15, fontWeight: "700" },
  btnSave:         { flex: 2, backgroundColor: "#4ECDC4", borderRadius: 14, padding: 14, alignItems: "center", shadowColor: "#4ECDC4", shadowOpacity: 0.4, shadowRadius: 10, elevation: 5 },
  btnSaveText:     { color: "white", fontSize: 15, fontWeight: "800" },
});
