export type DemoStudent = { id: string; name: string; classId: string; admissionCode: string };
export type DemoClass = { id: string; label: string };
export type PromotionDemoData = { provenance: "synthetic-demonstration-data"; sessions: { id: string; label: string }[]; classes: DemoClass[]; students: DemoStudent[] };

export const PROMOTION_DEMO_DATA: PromotionDemoData = {
  provenance: "synthetic-demonstration-data",
  sessions: [{ id: "demo-session-1", label: "Demo Year A" }, { id: "demo-session-2", label: "Demo Year B" }],
  classes: [{ id: "demo-class-1", label: "Demo Class 1" }, { id: "demo-class-2", label: "Demo Class 2" }, { id: "demo-class-3", label: "Demo Class 3" }],
  students: [
    { id: "demo-student-01", name: "Demo Learner 01", classId: "demo-class-1", admissionCode: "DEMO-001" },
    { id: "demo-student-02", name: "Demo Learner 02", classId: "demo-class-1", admissionCode: "DEMO-002" },
    { id: "demo-student-03", name: "Demo Learner 03", classId: "demo-class-1", admissionCode: "DEMO-003" },
    { id: "demo-student-04", name: "Demo Learner 04", classId: "demo-class-2", admissionCode: "DEMO-004" },
    { id: "demo-student-05", name: "Demo Learner 05", classId: "demo-class-2", admissionCode: "DEMO-005" },
    { id: "demo-student-06", name: "Demo Learner 06", classId: "demo-class-3", admissionCode: "DEMO-006" },
  ],
};

export type DemoStage = "select" | "review" | "confirmed";
export type PromotionDemoState = { sessionId: string; sourceClassId: string; destinationClassId: string; selectedStudentIds: string[]; stage: DemoStage; message: string };
export type PromotionDemoAction =
  | { type: "session"; id: string }
  | { type: "source"; id: string }
  | { type: "destination"; id: string }
  | { type: "toggle"; id: string }
  | { type: "review" }
  | { type: "back" }
  | { type: "confirm" }
  | { type: "reset" };

export const initialPromotionDemoState = (): PromotionDemoState => ({ sessionId: "", sourceClassId: "", destinationClassId: "", selectedStudentIds: [], stage: "select", message: "" });

export function validatePromotionDemo(state: PromotionDemoState, data: PromotionDemoData = PROMOTION_DEMO_DATA): string[] {
  const errors: string[] = [];
  if (!data.sessions.some(item => item.id === state.sessionId)) errors.push("Choose a demonstration session.");
  if (!data.classes.some(item => item.id === state.sourceClassId)) errors.push("Choose a source class.");
  if (!data.classes.some(item => item.id === state.destinationClassId)) errors.push("Choose a destination class.");
  if (state.sourceClassId && state.sourceClassId === state.destinationClassId) errors.push("Choose a different destination class for this proposed UX flow.");
  if (!state.selectedStudentIds.length) errors.push("Select at least one demonstration student.");
  if (state.selectedStudentIds.some(id => !data.students.some(student => student.id === id && student.classId === state.sourceClassId))) errors.push("Selection contains a student outside the demonstration source class.");
  return errors;
}

export function reducePromotionDemo(state: PromotionDemoState, action: PromotionDemoAction, data: PromotionDemoData = PROMOTION_DEMO_DATA): PromotionDemoState {
  if (action.type === "reset") return initialPromotionDemoState();
  if (action.type === "session") return { ...state, sessionId: data.sessions.some(item => item.id === action.id) ? action.id : "", selectedStudentIds: [], stage: "select", message: "" };
  if (action.type === "source") return { ...state, sourceClassId: data.classes.some(item => item.id === action.id) ? action.id : "", selectedStudentIds: [], stage: "select", message: "" };
  if (action.type === "destination") return { ...state, destinationClassId: data.classes.some(item => item.id === action.id) ? action.id : "", stage: "select", message: "" };
  if (action.type === "toggle") {
    if (state.stage !== "select" || !data.students.some(student => student.id === action.id && student.classId === state.sourceClassId)) return state;
    const selectedStudentIds = state.selectedStudentIds.includes(action.id) ? state.selectedStudentIds.filter(id => id !== action.id) : [...state.selectedStudentIds, action.id].sort();
    return { ...state, selectedStudentIds, message: "" };
  }
  if (action.type === "review") {
    const errors = validatePromotionDemo(state, data);
    return errors.length ? { ...state, stage: "select", message: errors.join(" ") } : { ...state, stage: "review", message: "" };
  }
  if (action.type === "back") return { ...state, stage: "select", message: "" };
  if (action.type === "confirm") return state.stage === "review" && !validatePromotionDemo(state, data).length ? { ...state, stage: "confirmed", message: "Simulation complete. No records were changed." } : state;
  return state;
}
