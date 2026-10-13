#!/usr/bin/env python3
"""Builds power-automate/BZL Print Lab Submissions.xlsx: the Excel log the
Power Automate flow writes to (table "Submissions") and a Dashboard sheet that
summarises it with live formulas and charts.

    pip install openpyxl
    python3 tools/make-workbook.py [--sample out.xlsx]   # --sample adds fake rows for testing

The column headers must match the "Add a row into a table" mapping in
power-automate/README.md.
"""
import sys
from datetime import date, timedelta
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Font, PatternFill, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table, TableStyleInfo

OUT = 'power-automate/BZL Print Lab Submissions.xlsx'

# (header, width, row key the flow fills in — see power-automate/README.md)
COLUMNS = [
    ('Submitted', 17, 'submitted'),
    ('Submission ID', 14, 'id'),
    ('Status', 16, None),          # the flow writes "New"; the lab updates it
    ('Center', 30, 'center'),
    ('Name', 18, 'name'),
    ('ID number', 12, 'idNumber'),
    ('Email', 26, 'email'),
    ('Phone', 14, 'phone'),
    ('Department', 18, 'department'),
    ('Course', 20, 'course'),
    ('Deadline', 12, 'deadline'),
    ('Pieces', 8, 'pieces'),
    ('Color', 18, 'color'),
    ('Profile', 12, 'profile'),
    ('Est. time (min)', 10, 'estMinutes'),
    ('Est. cost (ILS)', 10, 'estCost'),
    ('Plates', 8, 'plates'),
    ('Filament (g)', 10, 'grams'),
    ('Objects', 40, 'objects'),
    ('Supports', 9, 'supports'),
    ('Files', 34, 'files'),
    ('Folder', 34, 'folder'),
    ('Student notes', 34, 'notes'),
    ('Lab notes', 30, None),
]

STATUSES = ['New', 'In review', 'Queued', 'Printing', 'Ready for pickup', 'Picked up', 'On hold', 'Rejected', 'Cancelled']
STATUS_COLORS = {
    'New': 'FFF2CC', 'In review': 'FCE5CD', 'Queued': 'CFE2F3', 'Printing': 'D9D2E9', 'Ready for pickup': 'D9EAD3',
    'Picked up': 'B6D7A8', 'On hold': 'F4CCCC', 'Rejected': 'EA9999', 'Cancelled': 'CCCCCC',
}
OPEN = ['New', 'In review', 'Queued', 'Printing', 'On hold']   # not finished yet
CENTERS = ['Bezalel Main Modelling Center', 'Bezalel Architecture Modelling Center']

DARK = '1F2428'
GREEN = '00AE42'
head_font = Font(bold=True, color='FFFFFF')
head_fill = PatternFill('solid', fgColor=DARK)
title_font = Font(bold=True, size=16)
h2_font = Font(bold=True, size=12)
muted = Font(color='6B7378', size=9)
kpi_font = Font(bold=True, size=20)
thin = Side(style='thin', color='D5DADD')
box = Border(top=thin, bottom=thin, left=thin, right=thin)


def col(header):
    return f'Submissions[{header}]'


def num(header):
    """Numeric column that works whether the flow stored numbers or text (and with blank rows)."""
    return f'--("0"&{col(header)})'


def status_is(statuses):
    return '(' + '+'.join(f'({col("Status")}="{s}")' for s in statuses) + ')'


def build(sample=False):
    wb = Workbook()
    ws = wb.active
    ws.title = 'Submissions'
    for i, (h, w, _) in enumerate(COLUMNS, 1):
        c = ws.cell(row=1, column=i, value=h)
        ws.column_dimensions[get_column_letter(i)].width = w
    rows = sample_rows() if sample else []
    for r, values in enumerate(rows, 2):
        for i, v in enumerate(values, 1):
            ws.cell(row=r, column=i, value=v)
    last = max(2, len(rows) + 1)
    ref = f'A1:{get_column_letter(len(COLUMNS))}{last}'
    table = Table(displayName='Submissions', ref=ref)
    table.tableStyleInfo = TableStyleInfo(name='TableStyleMedium15', showRowStripes=True)
    ws.add_table(table)
    ws.freeze_panes = 'C2'
    for c in ws[1]:
        c.alignment = Alignment(vertical='center', wrap_text=True)
    ws.row_dimensions[1].height = 30
    # Status: dropdown + colour per status (whole column, so new rows get it too).
    st = get_column_letter(3)
    dv = DataValidation(type='list', formula1='"' + ','.join(STATUSES) + '"', allow_blank=True)
    dv.error = 'Choose a status from the list.'
    dv.add(f'{st}2:{st}5000')
    ws.add_data_validation(dv)
    for s, color in STATUS_COLORS.items():
        ws.conditional_formatting.add(f'{st}2:{st}5000', FormulaRule(formula=[f'${st}2="{s}"'], fill=PatternFill('solid', fgColor=color)))
    for letter in ('S', 'U', 'W', 'X'):  # long text columns wrap
        for r in range(2, last + 1):
            ws[f'{letter}{r}'].alignment = Alignment(wrap_text=True, vertical='top')

    dashboard(wb)
    return wb


def dashboard(wb):
    d = wb.create_sheet('Dashboard', 0)
    d.sheet_view.showGridLines = False
    widths = [2, 24, 14, 14, 14, 14, 14, 2, 14, 14, 14, 14, 14]
    for i, w in enumerate(widths, 1):
        d.column_dimensions[get_column_letter(i)].width = w
    d['B2'] = 'BZL Print Lab – Dashboard'
    d['B2'].font = title_font
    d['B3'] = 'Updates by itself from the Submissions sheet. Change a submission\'s Status there.'
    d['B3'].font = muted
    d['B4'] = '="As of "&TEXT(TODAY(),"yyyy-mm-dd")'
    d['B4'].font = muted

    # --- KPIs (row 6 labels, row 7 values)
    kpis = [
        ('Submissions', f'=SUMPRODUCT(--({col("Submission ID")}<>""))'),
        ('Waiting (New + In review)', f'=SUMPRODUCT({status_is(["New", "In review"])})'),
        ('Queued + Printing', f'=SUMPRODUCT({status_is(["Queued", "Printing"])})'),
        ('Ready for pickup', f'=COUNTIFS({col("Status")},"Ready for pickup")'),
        ('Overdue (open, deadline passed)', '=SUMPRODUCT({open}*({dl}<>"")*(LEFT(TEXT({dl},"yyyy-mm-dd"),10)<TEXT(TODAY(),"yyyy-mm-dd")))'.format(
            open=status_is(OPEN), dl=col('Deadline'))),
        ('Due in the next 7 days (open)', '=SUMPRODUCT({open}*({dl}<>"")*(LEFT(TEXT({dl},"yyyy-mm-dd"),10)>=TEXT(TODAY(),"yyyy-mm-dd"))*(LEFT(TEXT({dl},"yyyy-mm-dd"),10)<=TEXT(TODAY()+7,"yyyy-mm-dd")))'.format(
            open=status_is(OPEN), dl=col('Deadline'))),
    ]
    kpis2 = [
        ('Open work (est. hours)', f'=ROUND(SUMPRODUCT({status_is(OPEN)}*{num("Est. time (min)")})/60,1)'),
        ('Open filament (kg)', f'=ROUND(SUMPRODUCT({status_is(OPEN)}*{num("Filament (g)")})/1000,2)'),
        ('Open value (ILS)', f'=ROUND(SUMPRODUCT({status_is(OPEN)}*{num("Est. cost (ILS)")}),2)'),
        ('Picked up value (ILS)', f'=ROUND(SUMPRODUCT({status_is(["Picked up"])}*{num("Est. cost (ILS)")}),2)'),
        ('Pieces (all)', f'=SUMPRODUCT({num("Pieces")})'),
        ('Plates (all)', f'=SUMPRODUCT({num("Plates")})'),
    ]
    for block, (r0, items) in enumerate(((6, kpis), (9, kpis2))):
        for i, (label, f) in enumerate(items):
            c = 2 + i if i == 0 else 2 + i
            lc = d.cell(row=r0, column=c, value=label)
            lc.font = Font(size=9, color='4B5257')
            lc.alignment = Alignment(wrap_text=True, vertical='bottom')
            vc = d.cell(row=r0 + 1, column=c, value=f)
            vc.font = kpi_font
            vc.alignment = Alignment(horizontal='left')
            for rr in (r0, r0 + 1):
                d.cell(row=rr, column=c).border = box
                d.cell(row=rr, column=c).fill = PatternFill('solid', fgColor='F4F6F7')
        d.row_dimensions[r0].height = 30
        d.row_dimensions[r0 + 1].height = 30

    # --- By status and center (rows 13+)
    r = 13
    d.cell(row=r, column=2, value='By status').font = h2_font
    heads = ['Status', 'Main', 'Architecture', 'Total', 'Est. hours', 'Est. ILS']
    for i, h in enumerate(heads):
        c = d.cell(row=r + 1, column=2 + i, value=h)
        c.font = head_font
        c.fill = head_fill
    # Center names used by the formulas (must match what the site writes in the Center column).
    d['J13'] = 'Center names (as written by the site):'
    d['J13'].font = muted
    d['J14'] = CENTERS[0]
    d['J15'] = CENTERS[1]
    for a in ('J14', 'J15'):
        d[a].font = Font(size=9, color='4B5257')
    first = r + 2
    for k, s in enumerate(STATUSES):
        rr = first + k
        d.cell(row=rr, column=2, value=s).fill = PatternFill('solid', fgColor=STATUS_COLORS[s])
        d.cell(row=rr, column=3, value=f'=COUNTIFS({col("Status")},$B{rr},{col("Center")},$J$14)')
        d.cell(row=rr, column=4, value=f'=COUNTIFS({col("Status")},$B{rr},{col("Center")},$J$15)')
        d.cell(row=rr, column=5, value=f'=COUNTIFS({col("Status")},$B{rr})')
        d.cell(row=rr, column=6, value=f'=ROUND(SUMPRODUCT(({col("Status")}=$B{rr})*{num("Est. time (min)")})/60,1)')
        d.cell(row=rr, column=7, value=f'=ROUND(SUMPRODUCT(({col("Status")}=$B{rr})*{num("Est. cost (ILS)")}),2)')
        for c in range(2, 8):
            d.cell(row=rr, column=c).border = box
    status_last = first + len(STATUSES) - 1

    # --- Per month, last 12 months (rows after)
    r = status_last + 3
    d.cell(row=r, column=2, value='Per month (submitted)').font = h2_font
    heads = ['Month', 'Main', 'Architecture', 'Submissions', 'Pieces', 'Est. hours', 'Est. ILS']
    for i, h in enumerate(heads):
        c = d.cell(row=r + 1, column=2 + i, value=h)
        c.font = head_font
        c.fill = head_fill
    mfirst = r + 2
    month = f'LEFT(TEXT({col("Submitted")},"yyyy-mm"),7)'
    for k in range(12):
        rr = mfirst + k
        d.cell(row=rr, column=2, value=f'=TEXT(EDATE(TODAY(),{k - 11}),"yyyy-mm")')
        d.cell(row=rr, column=3, value=f'=SUMPRODUCT(({month}=$B{rr})*({col("Center")}=$J$14))')
        d.cell(row=rr, column=4, value=f'=SUMPRODUCT(({month}=$B{rr})*({col("Center")}=$J$15))')
        d.cell(row=rr, column=5, value=f'=SUMPRODUCT(--({month}=$B{rr}))')
        d.cell(row=rr, column=6, value=f'=SUMPRODUCT(({month}=$B{rr})*{num("Pieces")})')
        d.cell(row=rr, column=7, value=f'=ROUND(SUMPRODUCT(({month}=$B{rr})*{num("Est. time (min)")})/60,1)')
        d.cell(row=rr, column=8, value=f'=ROUND(SUMPRODUCT(({month}=$B{rr})*{num("Est. cost (ILS)")}),2)')
        for c in range(2, 9):
            d.cell(row=rr, column=c).border = box
    mlast = mfirst + 11
    d.column_dimensions['H'].width = 12

    # --- Charts
    ch = BarChart()
    ch.type = 'bar'
    ch.style = 10
    ch.title = 'Submissions by status'
    ch.y_axis.title = None
    ch.add_data(Reference(d, min_col=3, max_col=4, min_row=14, max_row=status_last), titles_from_data=True)
    ch.set_categories(Reference(d, min_col=2, min_row=first, max_row=status_last))
    ch.grouping = 'stacked'
    ch.overlap = 100
    ch.height, ch.width = 8, 14
    ch.y_axis.majorGridlines = None
    ch.x_axis.scaling.orientation = 'maxMin'
    d.add_chart(ch, 'J17')

    cm = BarChart()
    cm.type = 'col'
    cm.style = 10
    cm.title = 'Submissions per month'
    cm.add_data(Reference(d, min_col=3, max_col=4, min_row=mfirst - 1, max_row=mlast), titles_from_data=True)
    cm.set_categories(Reference(d, min_col=2, min_row=mfirst, max_row=mlast))
    cm.grouping = 'stacked'
    cm.overlap = 100
    cm.height, cm.width = 8, 14
    d.add_chart(cm, f'J{mfirst - 1}')


def sample_rows():
    """Fake submissions for checking the formulas (not shipped)."""
    today = date.today()
    out = []
    data = [
        (0, 'New', 0, 3, 95, 12.5, 31.2, 2, 4),
        (1, 'In review', 1, -2, 60, 10, 12, 1, 1),
        (3, 'Queued', 0, 5, 300, 41.5, 150, 2, 3),
        (10, 'Printing', 1, 1, 120, 18, 60, 1, 2),
        (20, 'Ready for pickup', 0, -5, 30, 10, 5, 1, 1),
        (40, 'Picked up', 0, -30, 200, 30, 90, 1, 6),
        (70, 'Cancelled', 1, -60, 10, 10, 2, 1, 1),
    ]
    for days_ago, status, center, due, mins, cost, grams, plates, pieces in data:
        sub = today - timedelta(days=days_ago)
        values = [
            f'{sub:%Y-%m-%d} 10:00', f'P{sub:%y%m%d}-TST{days_ago}', status, CENTERS[center], 'Test Student', '012345678',
            't@example.com', '050-0000000', 'Design', 'Studio', f'{today + timedelta(days=due):%Y-%m-%d}', str(pieces),
            'White', 'Normal', str(mins), str(cost), str(plates), str(grams), 'x.stl ×1 (10 × 10 × 10)', 'No',
            'ORIGINAL – x.stl', 'folder', '', '',
        ]
        out.append(values)
    return out


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--sample':
        build(sample=True).save(sys.argv[2])
        print('Wrote', sys.argv[2])
    else:
        build().save(OUT)
        print('Wrote', OUT)
