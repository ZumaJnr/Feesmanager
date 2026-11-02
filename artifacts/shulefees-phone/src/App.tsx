import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft, ArrowLeft, Check, ChevronRight, CircleAlert, CreditCard,
  FileCheck2, Filter, GraduationCap, LayoutDashboard, LoaderCircle, Plus,
  Search, ShieldCheck, Users, Wallet, X,
} from 'lucide-react';
import {
  getGetFeeSummaryQueryKey, getListRecentPaymentsQueryKey,
  getListStudentPaymentsQueryKey, getListStudentsQueryKey,
  useCreateStudent, useGetFeeSummary, useHealthCheck, useListRecentPayments,
  useListStudentPayments, useListStudents, useRecordStudentPayment,
} from '@workspace/api-client-react';
import { Link, Route, Router as WouterRouter, Switch, useLocation, useParams } from 'wouter';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();
const money = (amount: number) => `KES ${Number(amount || 0).toLocaleString('en-KE')}`;
const dateLabel = (raw: string) => {
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
};
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase();

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const detail = location.startsWith('/students/');
  const health = useHealthCheck();
  return <div className="app-shell">
    <aside className="rail">
      <Link href="/" className="brand" data-testid="link-brand">
        <span className="brand-mark">S</span>
        <span><span className="brand-name">ShuleFees</span><span className="brand-sub">Pocket office</span></span>
      </Link>
      <div className="rail-label">Workspace</div>
      <nav aria-label="Main navigation">
        <Link href="/" className={`nav-link ${!detail ? 'active' : ''}`} data-testid="link-overview"><LayoutDashboard size={17} /> Overview</Link>
      </nav>
      <div className="rail-foot">
        <div className="office-pill"><span className={`office-dot ${health.isError ? 'offline' : ''}`} /><span><span className="office-title">School office</span><span className="office-meta">{health.isLoading ? 'Checking connection…' : health.isError ? 'Connection unavailable' : 'Office connection active'}</span></span></div>
      </div>
    </aside>
    <main className="main-area">
      <header className="topbar">
        <div className="crumb">School office <span aria-hidden="true">/</span> <strong>{detail ? 'Student account' : 'Fees overview'}</strong></div>
        <div className="top-right">
          <span className="date-label">{new Intl.DateTimeFormat('en-KE', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date())}</span>
          <div className="user-chip"><span className="user-avatar">BO</span><span><span className="user-name">Bursar office</span><span className="user-role">School administrator</span></span></div>
        </div>
      </header>
      {children}
    </main>
  </div>;
}

function LoadingPanel({ rows = 4 }: { rows?: number }) {
  return <div className="loading-state" aria-label="Loading records"><div className="skeleton" style={{ width: '42%' }} /><div className="skeleton" style={{ width: '82%' }} /><div className="skeleton" style={{ width: '66%' }} />{rows > 3 && <div className="skeleton" style={{ width: '75%' }} />}</div>;
}

function ErrorNotice({ retry }: { retry: () => void }) {
  return <div className="error-state"><CircleAlert size={20} style={{ marginBottom: 8 }} /><div>We couldn’t load these records.</div><button className="button secondary small" style={{ marginTop: 12 }} onClick={retry} data-testid="button-retry">Try again</button></div>;
}

function Modal({ title, description, close, children }: { title: string; description: string; close: () => void; children: ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <div className="modal-head"><div><h2 id="dialog-title" className="modal-title">{title}</h2><p className="modal-desc">{description}</p></div><button className="icon-button" aria-label="Close dialog" onClick={close} data-testid="button-close-dialog"><X size={16} /></button></div>
      {children}
    </section>
  </div>;
}

function Stat({ label, value, caption, featured = false, icon }: { label: string; value: string; caption: string; featured?: boolean; icon: ReactNode }) {
  return <div className={`stat-card ${featured ? 'featured' : ''}`}><div className="stat-label">{icon}{label}</div><div className="stat-value">{value}</div><div className="stat-caption">{caption}</div></div>;
}

function Activity({ payments, isLoading, isError, retry }: { payments: any[]; isLoading: boolean; isError: boolean; retry: () => void }) {
  return <section className="panel">
    <div className="panel-head"><div><h2 className="panel-title">Recent payments</h2><p className="panel-caption">Latest entries in the fee book</p></div><span className="panel-count">Latest</span></div>
    {isLoading ? <LoadingPanel rows={4} /> : isError ? <ErrorNotice retry={retry} /> : payments.length === 0 ?
      <div className="empty-state"><div className="empty-icon"><CreditCard size={18} /></div><strong>No payments recorded yet</strong><div style={{ marginTop: 5 }}>Receipts will appear here after they’re entered.</div></div> :
      <div className="activity-list">{payments.slice(0, 6).map((payment) => <div className="activity-item" key={payment.id} data-testid={`payment-activity-${payment.id}`}>
        <div className="activity-icon"><ArrowDownLeft size={15} /></div><div className="activity-main">
          <div className="activity-row"><span className="activity-name">{payment.studentName}</span><span className="activity-amount">+{money(payment.amount)}</span></div>
          <div className="activity-meta">{dateLabel(payment.date)} <span aria-hidden="true">·</span> <span className="receipt-code">{payment.receiptCode}</span></div>
        </div>
      </div>)}
      <div className="activity-note">Payment records are bookkeeping entries only. No M-Pesa transaction is initiated.</div></div>}
  </section>;
}

function Dashboard() {
  const [search, setSearch] = useState('');
  const [classFilter, setClassFilter] = useState('all');
  const [addOpen, setAddOpen] = useState(false);
  const queryClient = useQueryClient();
  const summary = useGetFeeSummary();
  const studentsQuery = useListStudents(search.trim() ? { q: search.trim() } : undefined);
  const recent = useListRecentPayments({ limit: 8 });
  const createStudent = useCreateStudent();
  const students = studentsQuery.data ?? [];
  const classes = useMemo(() => Array.from(new Set(students.map(student => student.className))).sort(), [students]);
  const filtered = classFilter === 'all' ? students : students.filter(student => student.className === classFilter);
  const reload = () => { void summary.refetch(); void studentsQuery.refetch(); void recent.refetch(); };
  const create = (data: { name: string; adm: string; className: string; totalFee: number }) => createStudent.mutate({ data }, {
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetFeeSummaryQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListStudentsQueryKey() }),
      ]);
      setAddOpen(false);
    },
  });
  return <div className="page">
    <div className="page-heading"><div><p className="eyebrow">Term account book</p><h1>Fees overview</h1><p className="subhead">A clear picture of every shilling owed and received.</p></div><button className="button" onClick={() => setAddOpen(true)} data-testid="button-add-student"><Plus size={16} /> Add student</button></div>
    {summary.isLoading ? <div className="summary-grid">{[1, 2, 3, 4].map(item => <div className="stat-card" key={item}><div className="skeleton" style={{ width: '52%' }} /><div className="skeleton" style={{ width: '73%', height: 25, marginTop: 20 }} /></div>)}</div> : summary.isError ?
      <div className="panel" style={{ marginBottom: 24 }}><ErrorNotice retry={reload} /></div> : <div className="summary-grid">
        <Stat label="Collected so far" value={money(summary.data?.totalCollected ?? 0)} caption={`${summary.data?.studentCount ?? 0} student accounts`} featured icon={<Wallet size={14} />} />
        <Stat label="Outstanding" value={money(summary.data?.outstandingBalance ?? 0)} caption={`${summary.data?.studentsWithBalance ?? 0} accounts with a balance`} icon={<Filter size={14} />} />
        <Stat label="Expected fees" value={money(summary.data?.totalFees ?? 0)} caption="Total fees entered" icon={<FileCheck2 size={14} />} />
        <Stat label="Students" value={String(summary.data?.studentCount ?? 0)} caption="Accounts in this school" icon={<Users size={14} />} />
      </div>}
    <div className="content-grid">
      <section className="panel">
        <div className="panel-head"><div><h2 className="panel-title">Student accounts</h2><p className="panel-caption">Search by name or admission number</p></div><span className="panel-count">{students.length} students</span></div>
        <div className="toolbar">
          <label className="search-wrap"><Search size={15} /><input aria-label="Search students" type="search" placeholder="Search students..." value={search} onChange={event => setSearch(event.target.value)} data-testid="input-search-students" /></label>
          <select aria-label="Filter by class" className="filter-select" value={classFilter} onChange={event => setClassFilter(event.target.value)} data-testid="select-class-filter"><option value="all">All classes</option>{classes.map(className => <option value={className} key={className}>{className}</option>)}</select>
        </div>
        {studentsQuery.isLoading ? <LoadingPanel /> : studentsQuery.isError ? <ErrorNotice retry={() => void studentsQuery.refetch()} /> : filtered.length === 0 ?
          <div className="empty-state"><div className="empty-icon"><GraduationCap size={18} /></div><strong>{search ? 'No matching students' : 'Your fee book is ready'}</strong><div style={{ marginTop: 5 }}>{search ? 'Try another name or admission number.' : 'Add a student to begin keeping balances.'}</div>{!search && <button className="button small" style={{ marginTop: 14 }} onClick={() => setAddOpen(true)} data-testid="button-empty-add"><Plus size={14} /> Add first student</button>}</div> :
          <div className="table-wrap"><table><thead><tr><th>Student</th><th>Class</th><th>Term fee</th><th>Balance</th><th aria-label="Open account" /></tr></thead><tbody>{filtered.map(student => <tr key={student.id} data-testid={`row-student-${student.id}`}>
            <td><Link href={`/students/${student.id}`} className="student-link" data-testid={`link-student-${student.id}`}><span className="initials">{initials(student.name)}</span><span>{student.name}<span className="student-sub">ADM {student.adm}</span></span></Link></td>
            <td>{student.className}</td><td className="money">{money(student.totalFee)}</td><td><span className={`balance-tag ${student.balance <= 0 ? 'clear' : ''}`}>{student.balance <= 0 ? 'Cleared' : money(student.balance)}</span></td>
            <td><Link href={`/students/${student.id}`} aria-label={`Open ${student.name} account`} data-testid={`open-student-${student.id}`}><ChevronRight size={15} color="#9ba49a" /></Link></td>
          </tr>)}</tbody></table></div>}
      </section>
      <Activity payments={recent.data ?? summary.data?.recentPayments ?? []} isLoading={recent.isLoading} isError={recent.isError && !summary.data} retry={reload} />
    </div>
    {addOpen && <Modal title="Add a student" description="Start a clear account in the school fee book." close={() => setAddOpen(false)}>
      <form onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const amount = Number(form.get('totalFee')); if (!String(form.get('name') || '').trim() || !String(form.get('adm') || '').trim() || !String(form.get('className') || '').trim() || Number.isNaN(amount) || amount < 0 || !String(form.get('totalFee') ?? '')) return; create({ name: String(form.get('name')).trim(), adm: String(form.get('adm')).trim(), className: String(form.get('className')).trim(), totalFee: amount }); }}>
        <div className="field"><label htmlFor="name">Student name</label><input name="name" id="name" required placeholder="e.g. Wanjiku Kamau" data-testid="input-student-name" /></div>
        <div className="field"><label htmlFor="adm">Admission number</label><input name="adm" id="adm" required placeholder="e.g. 24-018" data-testid="input-admission" /></div>
        <div className="field"><label htmlFor="className">Class</label><input name="className" id="className" required placeholder="e.g. Form 2 East" data-testid="input-class" /></div>
        <div className="field"><label htmlFor="totalFee">Term fee (KES)</label><input name="totalFee" id="totalFee" type="number" min="0" step="1" required placeholder="e.g. 28500" data-testid="input-total-fee" /></div>
        {createStudent.isError && <div className="form-error">{(createStudent.error as any)?.message ?? 'Student could not be added. Please try again.'}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setAddOpen(false)} data-testid="button-cancel-student">Cancel</button><button className="button" type="submit" disabled={createStudent.isPending} data-testid="button-save-student">{createStudent.isPending ? <LoaderCircle size={15} /> : <Plus size={15} />}{createStudent.isPending ? 'Adding...' : 'Add student'}</button></div>
      </form>
    </Modal>}
  </div>;
}

function PaymentDialog({ studentId, studentName, balance, close, onSave, pending, error }: { studentId: number; studentName: string; balance: number; close: () => void; onSave: (data: { amount: number; phone: string }) => void; pending: boolean; error: string }) {
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [formError, setFormError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const numeric = Number(amount);
    if (!amount || !Number.isFinite(numeric) || numeric < 1) { setFormError('Enter a payment amount of at least KES 1.'); return; }
    if (phone.replace(/\D/g, '').length < 9 || phone.replace(/\D/g, '').length > 15) { setFormError('Enter a valid phone number, 9 to 15 digits.'); return; }
    setFormError(''); onSave({ amount: numeric, phone: phone.trim() });
  };
  return <Modal title="Record a payment" description={`Enter a payment received for ${studentName}.`} close={close}>
    <form onSubmit={submit}>
      <div className="field"><label htmlFor="payment-amount">Amount received (KES)</label><input id="payment-amount" autoFocus type="number" min="1" step="1" value={amount} onChange={event => setAmount(event.target.value)} placeholder="e.g. 5000" data-testid="input-payment-amount" /><p className="field-help">Current balance: {money(balance)}. Partial payments are welcome.</p></div>
      <div className="field"><label htmlFor="payment-phone">Payer phone number</label><input id="payment-phone" type="tel" inputMode="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="e.g. 0712 345 678" data-testid="input-payment-phone" /></div>
      <div className="receipt-callout"><ShieldCheck size={16} /><span>This records a bookkeeping entry and generates a ShuleFees receipt reference. It does not initiate an M-Pesa transaction.</span></div>
      {formError && <p className="field-error">{formError}</p>}{error && <div className="form-error">{error}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={close} data-testid="button-cancel-payment">Cancel</button><button className="button" type="submit" disabled={pending} data-testid="button-save-payment">{pending ? <LoaderCircle size={15} /> : <Check size={15} />}{pending ? 'Recording...' : 'Record payment'}</button></div>
    </form>
  </Modal>;
}

function StudentDetail() {
  const params = useParams<{ studentId: string }>();
  const studentId = Number(params.studentId);
  const queryClient = useQueryClient();
  const [paymentOpen, setPaymentOpen] = useState(false);
  const studentQuery = useListStudents();
  const paymentsQuery = useListStudentPayments(studentId);
  const recordPayment = useRecordStudentPayment();
  const student = studentQuery.data?.find(item => item.id === studentId);
  const updatePayment = (data: { amount: number; phone: string }) => {
    recordPayment.mutate({ studentId, data }, {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getListStudentPaymentsQueryKey(studentId) }),
          queryClient.invalidateQueries({ queryKey: getListStudentsQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getGetFeeSummaryQueryKey() }),
          queryClient.invalidateQueries({ queryKey: getListRecentPaymentsQueryKey({ limit: 8 }) }),
          queryClient.invalidateQueries({ queryKey: getListRecentPaymentsQueryKey() }),
        ]);
        setPaymentOpen(false);
      },
    });
  };
  if (studentQuery.isLoading) return <div className="page"><LoadingPanel /></div>;
  if (studentQuery.isError) return <div className="page"><ErrorNotice retry={() => void studentQuery.refetch()} /></div>;
  if (!student) return <div className="page"><Link href="/" className="detail-back" data-testid="link-back-overview"><ArrowLeft size={15} /> Back to overview</Link><div className="panel"><div className="empty-state"><div className="empty-icon"><Users size={18} /></div><strong>Student account not found</strong><div style={{ marginTop: 5 }}>This student may have been removed from the fee book.</div></div></div></div>;
  const paid = Math.max(student.totalFee - student.balance, 0);
  return <div className="page">
    <Link href="/" className="detail-back" data-testid="link-back-overview"><ArrowLeft size={15} /> All students</Link>
    <div className="page-heading"><div><p className="eyebrow">Student account</p><h1>{student.name}</h1><p className="subhead">{student.className} <span aria-hidden="true">·</span> ADM {student.adm}</p></div><button className="button" onClick={() => setPaymentOpen(true)} data-testid="button-record-payment"><Plus size={16} /> Record payment</button></div>
    <div className="detail-hero"><div className="detail-person"><div className="initials">{initials(student.name)}</div><div><h2 className="detail-name">{student.name}</h2><div className="detail-adm">ADMISSION {student.adm} <span aria-hidden="true">·</span> {student.className}</div></div></div><div className="detail-balance"><div className="stat-label">Outstanding balance</div><div className="stat-value">{money(student.balance)}</div></div></div>
    <div className="detail-grid">
      <section className="panel"><div className="panel-head"><div><h2 className="panel-title">Payment history</h2><p className="panel-caption">Bookkeeping entries for this account</p></div><span className="panel-count">{paymentsQuery.data?.length ?? 0} entries</span></div>
        {paymentsQuery.isLoading ? <LoadingPanel /> : paymentsQuery.isError ? <ErrorNotice retry={() => void paymentsQuery.refetch()} /> : !paymentsQuery.data?.length ?
          <div className="empty-state"><div className="empty-icon"><CreditCard size={18} /></div><strong>No payments recorded</strong><div style={{ marginTop: 5 }}>Entries added to this account will appear here.</div><button className="button small" style={{ marginTop: 14 }} onClick={() => setPaymentOpen(true)} data-testid="button-first-payment"><Plus size={14} /> Record first payment</button></div> :
          paymentsQuery.data.map(payment => <div className="payment-row" key={payment.id} data-testid={`payment-history-${payment.id}`}><div><strong>{dateLabel(payment.date)}</strong><span>{payment.phone}</span><span className="receipt-chip">{payment.receiptCode}</span></div><div className="payment-right"><strong>+{money(payment.amount)}</strong><span>Recorded</span></div></div>)}
      </section>
      <div>
        <div className="detail-stats"><div className="mini-stat"><div className="mini-stat-label">Term fee</div><div className="mini-stat-value">{money(student.totalFee)}</div></div><div className="mini-stat"><div className="mini-stat-label">Collected</div><div className="mini-stat-value">{money(paid)}</div></div></div>
        <section className="panel"><div className="panel-head"><div><h2 className="panel-title">Account note</h2><p className="panel-caption">A dependable record, entry by entry.</p></div></div><div style={{ padding: '0 20px 19px', color: '#76837a', fontSize: 11, lineHeight: 1.65 }}>Each payment is saved as a school bookkeeping entry with its own receipt reference. No mobile money transaction is started from this screen.</div></section>
      </div>
    </div>
    {paymentOpen && <PaymentDialog studentId={student.id} studentName={student.name} balance={student.balance} close={() => setPaymentOpen(false)} onSave={updatePayment} pending={recordPayment.isPending} error={recordPayment.isError ? (recordPayment.error as any)?.message ?? 'Payment could not be recorded. Please try again.' : ''} />}
  </div>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function Router() {
  return <RoutedErrorBoundary><Shell><Switch>
    <Route path="/" component={Dashboard} />
    <Route path="/students/:studentId" component={StudentDetail} />
    <Route component={NotFound} />
  </Switch></Shell></RoutedErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;
