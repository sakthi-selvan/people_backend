export const ROLES = ['hr', 'employee', 'device']

export const HR_STEPS = [
  { id: 1, key: 'offer_letter', label: 'Offer Letter', actor: 'hr' },
  { id: 2, key: 'acceptance', label: 'Acceptance Acknowledgement', actor: 'employee' },
  { id: 3, key: 'document_upload', label: 'Employee Documentation Upload', actor: 'employee' },
  { id: 4, key: 'document_verify', label: 'Documentation Verification & Approval', actor: 'hr' },
  { id: 5, key: 'joining_approval', label: 'Joining Approval', actor: 'hr_management' },
  { id: 6, key: 'appointment_letter', label: 'Appointment Letter', actor: 'hr' },
  { id: 7, key: 'onboarding', label: 'Employee Onboarding & Joining', actor: 'hr' },
  { id: 8, key: 'salary_processing', label: 'Salary Processing', actor: 'hr' },
  { id: 9, key: 'payslip_generation', label: 'Monthly Payslip Generation', actor: 'hr' },
  { id: 10, key: 'payslip_email', label: 'Payslip Email', actor: 'hr' },
  { id: 11, key: 'probation_review', label: 'Probation Review', actor: 'manager_hr' },
  { id: 12, key: 'confirmation_letter', label: 'Confirmation Letter', actor: 'hr' },
  { id: 13, key: 'resignation', label: 'Resignation Submission', actor: 'employee' },
  { id: 14, key: 'resignation_approval', label: 'Resignation Approval', actor: 'manager_hr_management' },
  { id: 15, key: 'handover', label: 'Handover Process', actor: 'employee_head' },
  { id: 16, key: 'exit_clearance', label: 'Exit Clearance', actor: 'hr' },
  { id: 17, key: 'fnf', label: 'Full & Final Settlement', actor: 'hr' },
  { id: 18, key: 'relieving_letter', label: 'Experience / Relieving Letter', actor: 'hr' },
]

export const ATTENDANCE_FLOW = [
  { id: 'onboarding', label: 'Employee onboarding' },
  { id: 'face', label: 'Face enrolment' },
  { id: 'punch', label: 'Daily check-in and check-out, or two halves of a 9-hour day' },
  { id: 'calc', label: 'Leave, shift and holiday calculation' },
  { id: 'approve', label: 'Monthly attendance approval' },
  { id: 'salary', label: 'Salary processing' },
  { id: 'payslip', label: 'Payslip generation, review and email' },
]

export const FACE_THRESHOLD = 0.55

export const OPS_STEP_IDS = [8, 9, 10]

export function nextLifecycleStep(hrStep) {
  if (hrStep >= 18) return null
  if (hrStep === 12) return null
  if (hrStep >= 7 && hrStep < 11) return null
  return hrStep + 1
}

export function isOpsStep(id) {
  return OPS_STEP_IDS.includes(id)
}
