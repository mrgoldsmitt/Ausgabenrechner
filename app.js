/**
 * Ausgabenrechner - App Logic
 * State management via XML DOMParser & XMLSerializer
 */

// --- Global Setup & State ---
const parser = new DOMParser();
const serializer = new XMLSerializer();

// Initial empty state
const initialStateXML = `
<app>
    <subtitle></subtitle>
    <incomes></incomes>
    <categories></categories>
    <expenses></expenses>
</app>
`;

// This is our single source of truth (an XML Document object)
let stateDoc;
let isFirstLoad = false;
const savedState = localStorage.getItem('ausgabenrechner_state');

if (savedState) {
    try {
        stateDoc = parser.parseFromString(savedState, "application/xml");
        if (stateDoc.documentElement.nodeName === "parsererror") {
            throw new Error("Invalid XML in localStorage");
        }
    } catch (e) {
        console.error("Failed to parse saved state, resetting:", e);
        stateDoc = parser.parseFromString(initialStateXML, "application/xml");
        isFirstLoad = true;
    }
} else {
    stateDoc = parser.parseFromString(initialStateXML, "application/xml");
    isFirstLoad = true;
}

function saveState() {
    const xmlString = serializer.serializeToString(stateDoc);
    localStorage.setItem('ausgabenrechner_state', xmlString);
    if (window.CryptoSync && window.CryptoSync.currentUser) {
        window.CryptoSync.triggerAutoSync(xmlString);
    }
}

// Chart.js instance reference
let expensesChartInstance = null;
let comparisonChartInstance = null;
let editingIncomeId = null;
let editingExpenseId = null;

// Chart Color Palette (Shades of Orange)
const chartColors = [
    '#ff5e00', '#ff8c00', '#ffaa00', '#ffc400', 
    '#ffdb4d', '#ff8040', '#e65c00', '#cc5200',
    '#ff9933', '#ffd699', '#b33c00', '#ff6600',
    '#ffcc66', '#d94c00', '#ffe6b3', '#802b00'
];

// --- DOM Elements ---
const dom = {
    totalIncomeValue: document.getElementById('totalIncomeValue'),
    totalExpensesValue: document.getElementById('totalExpensesValue'),
    effectiveNetValue: document.getElementById('effectiveNetValue'),
    
    incomeForm: document.getElementById('incomeForm'),
    incomeName: document.getElementById('incomeName'),
    incomeAmount: document.getElementById('incomeAmount'),
    incomesList: document.getElementById('incomesList'),
    emptyIncomesMsg: document.getElementById('emptyIncomesMsg'),
    
    categoryForm: document.getElementById('categoryForm'),
    newCategoryName: document.getElementById('newCategoryName'),
    categoryListContainer: document.getElementById('categoryListContainer'),
    expenseCategorySelect: document.getElementById('expenseCategory'),
    
    expenseForm: document.getElementById('expenseForm'),
    expenseName: document.getElementById('expenseName'),
    expenseAmount: document.getElementById('expenseAmount'),
    expensesList: document.getElementById('expensesList'),
    emptyExpensesMsg: document.getElementById('emptyExpensesMsg'),
    expenseSearch: document.getElementById('expenseSearch'),
    expenseSort: document.getElementById('expenseSort'),
    
    exportBtn: document.getElementById('exportBtn'),
    exportPdfBtn: document.getElementById('exportPdfBtn'),
    importInput: document.getElementById('importInput'),
    
    chartCanvas: document.getElementById('expensesChart'),
    comparisonChartCanvas: document.getElementById('comparisonChart'),
    subtitleInput: document.getElementById('subtitleInput')
};

// --- Helper Functions ---

// Generate UUID for expenses
function generateId() {
    return 'id-' + Math.random().toString(36).substr(2, 9);
}

// Format currency
function formatCurrency(amount) {
    return Number(amount).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
}

// Generate export filename: Ausgabenrechner_Untertitel_Datum_Uhrzeit
function getExportFilename(extension) {
    const subtitleNode = stateDoc.querySelector('subtitle');
    const subtitle = subtitleNode ? subtitleNode.textContent.trim() : '';
    
    const now = new Date();
    const datum = now.toLocaleDateString('de-DE', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\./g, '-');
    const uhrzeit = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }).replace(/:/g, '-');
    
    // Sonderzeichen entfernen, Leerzeichen durch Unterstriche
    const cleanSubtitle = subtitle.replace(/[^a-zA-Z0-9äöüÄÖÜß\s-]/g, '').replace(/\s+/g, '_');
    
    const parts = ['Ausgabenrechner'];
    if (cleanSubtitle) parts.push(cleanSubtitle);
    parts.push(datum);
    parts.push(uhrzeit);
    
    return parts.join('_') + '.' + extension;
}

// --- XML Data Access ---

function getIncomes() {
    const nodes = stateDoc.querySelectorAll('incomes > income');
    return Array.from(nodes).map(node => ({
        id: node.getAttribute('id'),
        name: node.querySelector('name').textContent,
        amount: parseFloat(node.querySelector('amount').textContent)
    }));
}

function addIncomeXML(name, amount) {
    // Falls <incomes> fehlt (alte XMLs), füge es hinzu
    let incNode = stateDoc.querySelector('incomes');
    if (!incNode) {
        incNode = stateDoc.createElement('incomes');
        stateDoc.documentElement.insertBefore(incNode, stateDoc.querySelector('categories'));
    }
    
    const newInc = stateDoc.createElement('income');
    newInc.setAttribute('id', generateId());
    
    const nNode = stateDoc.createElement('name');
    nNode.textContent = name;
    
    const aNode = stateDoc.createElement('amount');
    aNode.textContent = amount;
    
    newInc.appendChild(nNode);
    newInc.appendChild(aNode);
    
    incNode.appendChild(newInc);
}

function removeIncomeXML(id) {
    const node = stateDoc.querySelector(`income[id="${id}"]`);
    if (node) {
        node.parentNode.removeChild(node);
    }
}

function getCategories() {
    const nodes = stateDoc.querySelectorAll('categories > category');
    return Array.from(nodes).map(node => node.textContent);
}

function addCategoryXML(name) {
    const catsNode = stateDoc.querySelector('categories');
    const newCatNode = stateDoc.createElement('category');
    newCatNode.textContent = name;
    catsNode.appendChild(newCatNode);
}

function getExpenses() {
    const nodes = stateDoc.querySelectorAll('expenses > expense');
    return Array.from(nodes).map(node => ({
        id: node.getAttribute('id'),
        name: node.querySelector('name').textContent,
        amount: parseFloat(node.querySelector('amount').textContent),
        category: node.querySelector('category').textContent
    }));
}

function addExpenseXML(name, amount, category) {
    const expNode = stateDoc.querySelector('expenses');
    const newExp = stateDoc.createElement('expense');
    newExp.setAttribute('id', generateId());
    
    const nNode = stateDoc.createElement('name');
    nNode.textContent = name;
    
    const aNode = stateDoc.createElement('amount');
    aNode.textContent = amount;
    
    const cNode = stateDoc.createElement('category');
    cNode.textContent = category;
    
    newExp.appendChild(nNode);
    newExp.appendChild(aNode);
    newExp.appendChild(cNode);
    
    expNode.appendChild(newExp);
}

function removeExpenseXML(id) {
    const node = stateDoc.querySelector(`expense[id="${id}"]`);
    if (node) {
        node.parentNode.removeChild(node);
    }
}

// --- Render Logic ---

function render() {
    const incomes = getIncomes();
    const categories = getCategories();
    const expenses = getExpenses();
    
    // Untertitel aus XML laden (nur wenn Feld nicht gerade fokussiert ist)
    if (dom.subtitleInput && document.activeElement !== dom.subtitleInput) {
        const subtitleNode = stateDoc.querySelector('subtitle');
        dom.subtitleInput.value = subtitleNode ? subtitleNode.textContent : '';
    }
    
    // Calculate totals
    // check if old netIncome is present for backward compatibility
    let oldNetIncome = 0;
    const oldNetNode = stateDoc.querySelector('netIncome');
    if (oldNetNode) {
        oldNetIncome = parseFloat(oldNetNode.textContent) || 0;
    }

    const totalIncome = incomes.reduce((sum, inc) => sum + inc.amount, 0) + oldNetIncome;
    const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
    const effectiveNet = totalIncome - totalExpenses;
    
    // Render Totals
    dom.totalIncomeValue.textContent = formatCurrency(totalIncome);
    dom.totalExpensesValue.textContent = formatCurrency(totalExpenses);
    dom.effectiveNetValue.textContent = formatCurrency(effectiveNet);
    
    // Change color if negative
    if (effectiveNet < 0) {
        dom.effectiveNetValue.style.color = 'var(--color-danger)';
    } else {
        dom.effectiveNetValue.style.color = 'var(--color-primary)';
    }
    
    // Render Incomes List
    dom.incomesList.innerHTML = '';
    if (incomes.length === 0 && oldNetIncome === 0) {
        dom.emptyIncomesMsg.style.display = 'block';
    } else {
        dom.emptyIncomesMsg.style.display = 'none';
        
        if (oldNetIncome > 0) {
            const li = document.createElement('li');
            li.className = 'expense-item';
            li.innerHTML = `
                <div class="expense-info">
                    <span class="expense-name">Altes Nettoeinkommen</span>
                </div>
                <div class="expense-actions">
                    <span class="expense-amount" style="color: var(--color-primary);">${formatCurrency(oldNetIncome)}</span>
                </div>
            `;
            dom.incomesList.appendChild(li);
        }

        incomes.forEach(inc => {
            const li = document.createElement('li');
            li.className = 'expense-item';
            li.innerHTML = `
                <div class="expense-info">
                    <span class="expense-name">${inc.name}</span>
                </div>
                <div class="expense-actions">
                    <span class="expense-amount" style="color: var(--color-primary);">${formatCurrency(inc.amount)}</span>
                    <button class="btn-secondary income-edit" data-id="${inc.id}" title="Bearbeiten" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;">✎</button>
                    <button class="btn-danger income-delete" data-id="${inc.id}" title="Löschen">✕</button>
                </div>
            `;
            dom.incomesList.appendChild(li);
        });
    }
    
    // Render Categories Tags
    dom.categoryListContainer.innerHTML = '';
    categories.forEach(cat => {
        const span = document.createElement('span');
        span.className = 'tag';
        span.textContent = cat;
        dom.categoryListContainer.appendChild(span);
    });
    
    // Render Category Select Dropdown
    // Preserve current selection if possible
    const currentSelection = dom.expenseCategorySelect.value;
    dom.expenseCategorySelect.innerHTML = '<option value="" disabled selected>Kategorie wählen</option>';
    categories.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat;
        option.textContent = cat;
        dom.expenseCategorySelect.appendChild(option);
    });
    if (categories.includes(currentSelection)) {
        dom.expenseCategorySelect.value = currentSelection;
    }
    
    // Render Expenses List
    const searchTerm = dom.expenseSearch ? dom.expenseSearch.value.toLowerCase() : '';
    const filteredExpenses = expenses.filter(exp => 
        exp.name.toLowerCase().includes(searchTerm) || 
        exp.category.toLowerCase().includes(searchTerm) ||
        exp.amount.toString().includes(searchTerm)
    );

    dom.expensesList.innerHTML = '';
    if (filteredExpenses.length === 0) {
        dom.emptyExpensesMsg.textContent = searchTerm ? 'Keine Ausgaben gefunden.' : 'Noch keine Ausgaben erfasst.';
        dom.emptyExpensesMsg.style.display = 'block';
    } else {
        dom.emptyExpensesMsg.style.display = 'none';
        
        const sortMode = dom.expenseSort ? dom.expenseSort.value : 'group-category';
        
        if (sortMode.startsWith('group-')) {
            // Group expenses by category
            const groupedExpenses = {};
            filteredExpenses.forEach(exp => {
                if (!groupedExpenses[exp.category]) {
                    groupedExpenses[exp.category] = [];
                }
                groupedExpenses[exp.category].push(exp);
            });
            
            // Sort categories alphabetically
            const sortedCategories = Object.keys(groupedExpenses).sort();
            
            sortedCategories.forEach(category => {
                // Create category header
                const headerLi = document.createElement('li');
                headerLi.style.fontWeight = 'bold';
                headerLi.style.fontSize = '1.1rem';
                headerLi.style.marginTop = '1rem';
                headerLi.style.marginBottom = '0.5rem';
                headerLi.style.color = 'var(--color-primary)';
                headerLi.style.borderBottom = '2px solid var(--color-border)';
                
                // Sort expenses within category
                let categoryExpenses = groupedExpenses[category];
                
                // Calculate category total
                const categoryTotal = categoryExpenses.reduce((sum, exp) => sum + exp.amount, 0);
                
                headerLi.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span>${category}</span>
                        <span>${formatCurrency(categoryTotal)}</span>
                    </div>
                `;
                dom.expensesList.appendChild(headerLi);
                if (sortMode === 'group-amount-desc') {
                    categoryExpenses.sort((a, b) => b.amount - a.amount);
                } else if (sortMode === 'group-name-asc') {
                    categoryExpenses.sort((a, b) => a.name.localeCompare(b.name));
                }
                
                // Add expenses for this category
                categoryExpenses.forEach(exp => {
                    const li = document.createElement('li');
                    li.className = 'expense-item';
                    li.innerHTML = `
                        <div class="expense-info">
                            <span class="expense-name">${exp.name}</span>
                        </div>
                        <div class="expense-actions">
                            <span class="expense-amount">${formatCurrency(exp.amount)}</span>
                            <button class="btn-secondary expense-edit" data-id="${exp.id}" title="Bearbeiten" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;">✎</button>
                            <button class="btn-danger expense-delete" data-id="${exp.id}" title="Löschen">✕</button>
                        </div>
                    `;
                    dom.expensesList.appendChild(li);
                });
            });
        } else {
            // Flat list sorting
            let sortedExpenses = [...filteredExpenses];
            if (sortMode === 'flat-amount-desc') {
                sortedExpenses.sort((a, b) => b.amount - a.amount);
            } else if (sortMode === 'flat-amount-asc') {
                sortedExpenses.sort((a, b) => a.amount - b.amount);
            } else if (sortMode === 'flat-name-asc') {
                sortedExpenses.sort((a, b) => a.name.localeCompare(b.name));
            }
            
            sortedExpenses.forEach(exp => {
                const li = document.createElement('li');
                li.className = 'expense-item';
                li.innerHTML = `
                    <div class="expense-info">
                        <span class="expense-name">${exp.name}</span>
                        <span class="expense-meta">${exp.category}</span>
                    </div>
                    <div class="expense-actions">
                        <span class="expense-amount">${formatCurrency(exp.amount)}</span>
                        <button class="btn-secondary expense-edit" data-id="${exp.id}" title="Bearbeiten" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;">✎</button>
                        <button class="btn-danger expense-delete" data-id="${exp.id}" title="Löschen">✕</button>
                    </div>
                `;
                dom.expensesList.appendChild(li);
            });
        }
    }
    
    // Update Charts
    renderChart(expenses, categories, totalExpenses);
    renderComparisonChart(totalIncome, totalExpenses);
    
    // Save state to localStorage
    saveState();
}

function renderComparisonChart(totalIncome, totalExpenses) {
    if (!dom.comparisonChartCanvas) return;
    
    if (comparisonChartInstance) {
        comparisonChartInstance.data.datasets[0].data = [totalIncome, totalExpenses];
        comparisonChartInstance.update();
    } else {
        const ctx = dom.comparisonChartCanvas.getContext('2d');
        comparisonChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ['Einnahmen', 'Ausgaben'],
                datasets: [{
                    label: 'Vergleich',
                    data: [totalIncome, totalExpenses],
                    backgroundColor: ['#ffb347', '#ff4d4d'],
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return formatCurrency(context.raw);
                            }
                        }
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        ticks: {
                            callback: function(value) {
                                return value + ' €';
                            }
                        }
                    }
                }
            }
        });
    }
}

function renderChart(expenses, categories, totalExpenses) {
    // Aggregate data by category
    const categoryTotals = {};
    categories.forEach(cat => categoryTotals[cat] = 0);
    expenses.forEach(exp => {
        if (categoryTotals[exp.category] !== undefined) {
            categoryTotals[exp.category] += exp.amount;
        } else {
            // Failsafe for expenses with deleted/missing categories
            categoryTotals[exp.category] = exp.amount;
        }
    });
    
    const labels = Object.keys(categoryTotals).filter(cat => categoryTotals[cat] > 0);
    const data = labels.map(cat => categoryTotals[cat]);
    
    // Render Breakdown
    const breakdownContainer = document.getElementById('chartBreakdown');
    if (breakdownContainer) {
        breakdownContainer.innerHTML = '';
        labels.forEach((cat, index) => {
            let val = data[index];
            let percentage = totalExpenses > 0 ? ((val / totalExpenses) * 100).toFixed(1) : 0;
            const color = chartColors[index % chartColors.length];
            
            const div = document.createElement('div');
            div.className = 'breakdown-item';
            div.innerHTML = `
                <div class="breakdown-cat">
                    <span class="breakdown-color" style="background-color: ${color}"></span>
                    <span>${cat}</span>
                </div>
                <div class="breakdown-val">${formatCurrency(val)} <span style="color: var(--color-text-muted); font-weight: normal;">(${percentage}%)</span></div>
            `;
            breakdownContainer.appendChild(div);
        });
    }

    // Re-use or initialize chart
    if (expensesChartInstance) {
        expensesChartInstance.data.labels = labels;
        expensesChartInstance.data.datasets[0].data = data;
        expensesChartInstance.update();
    } else {
        const ctx = dom.chartCanvas.getContext('2d');
        expensesChartInstance = new Chart(ctx, {
            type: 'pie',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: chartColors,
                    borderWidth: 2,
                    borderColor: '#ffffff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label = context.label || '';
                                let value = context.raw || 0;
                                let total = context.dataset.data.reduce((a, b) => a + b, 0);
                                let percentage = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                                
                                if (label) {
                                    label += ': ';
                                }
                                label += formatCurrency(value) + ' (' + percentage + '%)';
                                return label;
                            }
                        }
                    }
                }
            }
        });
    }
}

// --- Event Listeners ---

// Add or Update Income
dom.incomeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = dom.incomeName.value.trim();
    const amount = parseFloat(dom.incomeAmount.value);
    
    if (name && !isNaN(amount)) {
        if (editingIncomeId) {
            const node = stateDoc.querySelector(`income[id="${editingIncomeId}"]`);
            if (node) {
                node.querySelector('name').textContent = name;
                node.querySelector('amount').textContent = amount;
            }
            editingIncomeId = null;
            dom.incomeForm.querySelector('button[type="submit"]').textContent = 'Einnahme speichern';
        } else {
            addIncomeXML(name, amount);
        }
        dom.incomeName.value = '';
        dom.incomeAmount.value = '';
        render();
    }
});

// Remove or Edit Income (Event Delegation)
dom.incomesList.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') {
        const id = e.target.getAttribute('data-id');
        if (e.target.classList.contains('income-delete')) {
            removeIncomeXML(id);
            render();
        } else if (e.target.classList.contains('income-edit')) {
            const inc = getIncomes().find(i => i.id === id);
            if (inc) {
                dom.incomeName.value = inc.name;
                dom.incomeAmount.value = inc.amount;
                editingIncomeId = id;
                dom.incomeForm.querySelector('button[type="submit"]').textContent = 'Einnahme aktualisieren';
                dom.incomeName.focus();
                window.scrollTo({ top: dom.incomeForm.offsetTop - 100, behavior: 'smooth' });
            }
        }
    }
});

// Add Category
dom.categoryForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const catName = dom.newCategoryName.value.trim();
    if (catName && !getCategories().includes(catName)) {
        addCategoryXML(catName);
        dom.newCategoryName.value = '';
        render();
    } else if (getCategories().includes(catName)) {
        alert("Diese Kategorie existiert bereits.");
    }
});

// Add or Update Expense
dom.expenseForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = dom.expenseName.value.trim();
    const amount = parseFloat(dom.expenseAmount.value);
    const category = dom.expenseCategorySelect.value;
    
    if (name && !isNaN(amount) && category) {
        if (editingExpenseId) {
            const node = stateDoc.querySelector(`expense[id="${editingExpenseId}"]`);
            if (node) {
                node.querySelector('name').textContent = name;
                node.querySelector('amount').textContent = amount;
                node.querySelector('category').textContent = category;
            }
            editingExpenseId = null;
            dom.expenseForm.querySelector('button[type="submit"]').textContent = 'Ausgabe speichern';
        } else {
            addExpenseXML(name, amount, category);
        }
        dom.expenseName.value = '';
        dom.expenseAmount.value = '';
        // keep category selected for quick multi-entry
        render();
    }
});

// Remove or Edit Expense (Event Delegation)
dom.expensesList.addEventListener('click', (e) => {
    if (e.target.tagName === 'BUTTON') {
        const id = e.target.getAttribute('data-id');
        if (e.target.classList.contains('expense-delete') || e.target.classList.contains('btn-danger')) {
            removeExpenseXML(id);
            render();
        } else if (e.target.classList.contains('expense-edit')) {
            const exp = getExpenses().find(x => x.id === id);
            if (exp) {
                dom.expenseName.value = exp.name;
                dom.expenseAmount.value = exp.amount;
                dom.expenseCategorySelect.value = exp.category;
                editingExpenseId = id;
                dom.expenseForm.querySelector('button[type="submit"]').textContent = 'Ausgabe aktualisieren';
                dom.expenseName.focus();
                window.scrollTo({ top: dom.expenseForm.offsetTop - 100, behavior: 'smooth' });
            }
        }
    }
});

// Export PDF – nutzt die native Druckfunktion des Browsers
if (dom.exportPdfBtn) {
    dom.exportPdfBtn.addEventListener('click', () => {
        // document.title wird vom Browser als Dateiname im "Als PDF speichern"-Dialog verwendet
        const originalTitle = document.title;
        document.title = getExportFilename('pdf').replace('.pdf', '');
        window.print();
        // Titel nach dem Drucken wiederherstellen
        setTimeout(() => { document.title = originalTitle; }, 500);
    });
}

// Export XML
dom.exportBtn.addEventListener('click', () => {
    let xmlString = serializer.serializeToString(stateDoc);
    
    // Remove any existing XML declarations from the serialized string
    xmlString = xmlString.replace(/<\?xml[^>]*\?>\s*/g, '');
    
    // Add single XML declaration
    const finalXml = '<?xml version="1.0" encoding="UTF-8"?>\n' + xmlString;
    
    const blob = new Blob([finalXml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = getExportFilename('xml');
    document.body.appendChild(a);
    a.click();
    
    // Cleanup
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
});

// Import XML
dom.importInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
        let xmlContent = event.target.result;
        
        // Clean up multiple XML declarations (can occur in older exports)
        xmlContent = xmlContent.replace(/(<\?xml[^>]*\?>\s*)+/g, '<?xml version="1.0" encoding="UTF-8"?>\n');
        
        try {
            const newDoc = parser.parseFromString(xmlContent, "application/xml");
            
            // Basic validation
            if (newDoc.documentElement.nodeName === "parsererror") {
                throw new Error("Invalid XML format");
            }
            if (newDoc.documentElement.nodeName !== "app") {
                throw new Error("Invalid XML structure (missing <app> root)");
            }
            
            // Overwrite state
            stateDoc = newDoc;
            render();
            alert("Daten erfolgreich importiert!");
            
        } catch (error) {
            alert("Fehler beim Importieren der Datei: " + error.message);
        }
        
        // Reset file input
        dom.importInput.value = '';
    };
    reader.readAsText(file);
});

// Untertitel: Änderungen sofort in XML speichern
if (dom.subtitleInput) {
    dom.subtitleInput.addEventListener('input', () => {
        let subtitleNode = stateDoc.querySelector('subtitle');
        if (!subtitleNode) {
            subtitleNode = stateDoc.createElement('subtitle');
            stateDoc.documentElement.insertBefore(subtitleNode, stateDoc.documentElement.firstChild);
        }
        subtitleNode.textContent = dom.subtitleInput.value;
        saveState();
    });
}

if (dom.expenseSearch) {
    dom.expenseSearch.addEventListener('input', () => {
        render();
    });
}

if (dom.expenseSort) {
    dom.expenseSort.addEventListener('change', () => {
        render();
    });
}

// --- Initialization ---
// Set current date
const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
document.getElementById('currentDate').textContent = new Date().toLocaleDateString('de-DE', options);

// Add some default categories to start
if (isFirstLoad) {
    addCategoryXML("Miete");
    addCategoryXML("Lebensmittel");
    addCategoryXML("Freizeit");
    addCategoryXML("Mobilität");
    addCategoryXML("Sparen");
}

// Initial Render
render();

// --- Authentifizierung & Cloudflare D1 Sync Controller ---

const authDom = {
    authModal: document.getElementById('authModal'),
    openAuthModalBtn: document.getElementById('openAuthModalBtn'),
    closeAuthModalBtn: document.getElementById('closeAuthModalBtn'),
    modalTabsHeader: document.getElementById('modalTabsHeader'),
    tabLoginBtn: document.getElementById('tabLoginBtn'),
    tabRegisterBtn: document.getElementById('tabRegisterBtn'),
    
    // Forms
    loginForm: document.getElementById('loginForm'),
    registerForm: document.getElementById('registerForm'),
    forgotPasswordForm: document.getElementById('forgotPasswordForm'),
    resetPasswordForm: document.getElementById('resetPasswordForm'),
    
    // Login
    loginUsername: document.getElementById('loginUsername'),
    loginPassword: document.getElementById('loginPassword'),
    loginSubmitBtn: document.getElementById('loginSubmitBtn'),
    forgotPasswordLink: document.getElementById('forgotPasswordLink'),
    
    // Register
    regUsername: document.getElementById('regUsername'),
    regEmail: document.getElementById('regEmail'),
    regPassword: document.getElementById('regPassword'),
    regPasswordConfirm: document.getElementById('regPasswordConfirm'),
    regSubmitBtn: document.getElementById('regSubmitBtn'),
    
    // Forgot / Reset
    forgotEmail: document.getElementById('forgotEmail'),
    forgotSubmitBtn: document.getElementById('forgotSubmitBtn'),
    backToLoginFromForgot: document.getElementById('backToLoginFromForgot'),
    resetCode: document.getElementById('resetCode'),
    resetNewPassword: document.getElementById('resetNewPassword'),
    resetNewPasswordConfirm: document.getElementById('resetNewPasswordConfirm'),
    resetSubmitBtn: document.getElementById('resetSubmitBtn'),
    backToLoginFromReset: document.getElementById('backToLoginFromReset'),
    
    // Messages & State
    authErrorMsg: document.getElementById('authErrorMsg'),
    authSuccessMsg: document.getElementById('authSuccessMsg'),
    authStateLoggedOut: document.getElementById('authStateLoggedOut'),
    authStateLoggedIn: document.getElementById('authStateLoggedIn'),
    authUsername: document.getElementById('authUsername'),
    syncStatusBadge: document.getElementById('syncStatusBadge'),
    manualSyncBtn: document.getElementById('manualSyncBtn'),
    logoutBtn: document.getElementById('logoutBtn'),
    toast: document.getElementById('appToast'),

    // Scenario Bar & Modals
    scenarioBar: document.getElementById('scenarioBar'),
    scenarioSelect: document.getElementById('scenarioSelect'),
    newScenarioBtn: document.getElementById('newScenarioBtn'),
    renameScenarioBtn: document.getElementById('renameScenarioBtn'),
    deleteScenarioBtn: document.getElementById('deleteScenarioBtn'),
    
    newScenarioModal: document.getElementById('newScenarioModal'),
    closeNewScenarioModalBtn: document.getElementById('closeNewScenarioModalBtn'),
    newScenarioForm: document.getElementById('newScenarioForm'),
    newScenarioName: document.getElementById('newScenarioName'),
    cancelNewScenarioBtn: document.getElementById('cancelNewScenarioBtn'),
    submitNewScenarioBtn: document.getElementById('submitNewScenarioBtn'),
    
    renameScenarioModal: document.getElementById('renameScenarioModal'),
    closeRenameScenarioModalBtn: document.getElementById('closeRenameScenarioModalBtn'),
    renameScenarioForm: document.getElementById('renameScenarioForm'),
    renameScenarioInput: document.getElementById('renameScenarioInput'),
    cancelRenameScenarioBtn: document.getElementById('cancelRenameScenarioBtn'),
    submitRenameScenarioBtn: document.getElementById('submitRenameScenarioBtn')
};

// Toast notification helper
function showToast(message, duration = 3000) {
    if (!authDom.toast) return;
    authDom.toast.textContent = message;
    authDom.toast.classList.add('visible');
    setTimeout(() => {
        authDom.toast.classList.remove('visible');
    }, duration);
}

// Update UI based on authentication state
function updateAuthUI(user) {
    if (user) {
        if (authDom.authStateLoggedOut) authDom.authStateLoggedOut.style.display = 'none';
        if (authDom.authStateLoggedIn) authDom.authStateLoggedIn.style.display = 'inline-flex';
        if (authDom.authUsername) authDom.authUsername.textContent = user.username;
        if (authDom.openAuthModalBtn) authDom.openAuthModalBtn.style.display = 'none';
        if (authDom.manualSyncBtn) authDom.manualSyncBtn.style.display = 'inline-block';
        if (authDom.logoutBtn) authDom.logoutBtn.style.display = 'inline-block';
        if (authDom.scenarioBar) authDom.scenarioBar.style.display = 'flex';
    } else {
        if (authDom.authStateLoggedOut) authDom.authStateLoggedOut.style.display = 'inline-flex';
        if (authDom.authStateLoggedIn) authDom.authStateLoggedIn.style.display = 'none';
        if (authDom.openAuthModalBtn) authDom.openAuthModalBtn.style.display = 'inline-block';
        if (authDom.manualSyncBtn) authDom.manualSyncBtn.style.display = 'none';
        if (authDom.logoutBtn) authDom.logoutBtn.style.display = 'none';
        if (authDom.scenarioBar) authDom.scenarioBar.style.display = 'none';
    }
}

function showAuthError(msg) {
    if (authDom.authErrorMsg) {
        authDom.authErrorMsg.textContent = msg;
        authDom.authErrorMsg.style.display = 'block';
    }
    if (authDom.authSuccessMsg) {
        authDom.authSuccessMsg.style.display = 'none';
    }
}

function showAuthSuccess(msg) {
    if (authDom.authSuccessMsg) {
        authDom.authSuccessMsg.textContent = msg;
        authDom.authSuccessMsg.style.display = 'block';
    }
    if (authDom.authErrorMsg) {
        authDom.authErrorMsg.style.display = 'none';
    }
}

function clearAuthMessages() {
    if (authDom.authErrorMsg) authDom.authErrorMsg.style.display = 'none';
    if (authDom.authSuccessMsg) authDom.authSuccessMsg.style.display = 'none';
}

function resetAuthModalViews() {
    clearAuthMessages();
    if (authDom.modalTabsHeader) authDom.modalTabsHeader.style.display = 'flex';
    if (authDom.loginForm) authDom.loginForm.style.display = 'flex';
    if (authDom.registerForm) authDom.registerForm.style.display = 'none';
    if (authDom.forgotPasswordForm) authDom.forgotPasswordForm.style.display = 'none';
    if (authDom.resetPasswordForm) authDom.resetPasswordForm.style.display = 'none';
    if (authDom.tabLoginBtn) authDom.tabLoginBtn.classList.add('active');
    if (authDom.tabRegisterBtn) authDom.tabRegisterBtn.classList.remove('active');
}

// Modal open / close
if (authDom.openAuthModalBtn) {
    authDom.openAuthModalBtn.addEventListener('click', () => {
        resetAuthModalViews();
        authDom.authModal.classList.add('active');
        authDom.loginUsername.focus();
    });
}

if (authDom.closeAuthModalBtn) {
    authDom.closeAuthModalBtn.addEventListener('click', () => {
        authDom.authModal.classList.remove('active');
    });
}

if (authDom.authModal) {
    authDom.authModal.addEventListener('click', (e) => {
        if (e.target === authDom.authModal) {
            authDom.authModal.classList.remove('active');
        }
    });
}

// Tab Switching
if (authDom.tabLoginBtn && authDom.tabRegisterBtn) {
    authDom.tabLoginBtn.addEventListener('click', () => {
        authDom.tabLoginBtn.classList.add('active');
        authDom.tabRegisterBtn.classList.remove('active');
        authDom.loginForm.style.display = 'flex';
        authDom.registerForm.style.display = 'none';
        authDom.forgotPasswordForm.style.display = 'none';
        authDom.resetPasswordForm.style.display = 'none';
        clearAuthMessages();
    });

    authDom.tabRegisterBtn.addEventListener('click', () => {
        authDom.tabRegisterBtn.classList.add('active');
        authDom.tabLoginBtn.classList.remove('active');
        authDom.registerForm.style.display = 'flex';
        authDom.loginForm.style.display = 'none';
        authDom.forgotPasswordForm.style.display = 'none';
        authDom.resetPasswordForm.style.display = 'none';
        clearAuthMessages();
    });
}

// Password Reset Views
if (authDom.forgotPasswordLink) {
    authDom.forgotPasswordLink.addEventListener('click', (e) => {
        e.preventDefault();
        clearAuthMessages();
        authDom.modalTabsHeader.style.display = 'none';
        authDom.loginForm.style.display = 'none';
        authDom.registerForm.style.display = 'none';
        authDom.forgotPasswordForm.style.display = 'flex';
        authDom.resetPasswordForm.style.display = 'none';
        authDom.forgotEmail.focus();
    });
}

if (authDom.backToLoginFromForgot) {
    authDom.backToLoginFromForgot.addEventListener('click', (e) => {
        e.preventDefault();
        resetAuthModalViews();
    });
}

if (authDom.backToLoginFromReset) {
    authDom.backToLoginFromReset.addEventListener('click', (e) => {
        e.preventDefault();
        resetAuthModalViews();
    });
}

// Forgot Password Request Code
if (authDom.forgotPasswordForm) {
    authDom.forgotPasswordForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearAuthMessages();
        const email = authDom.forgotEmail.value.trim();
        if (!email) {
            showAuthError("Bitte E-Mail-Adresse eingeben.");
            return;
        }

        authDom.forgotSubmitBtn.disabled = true;
        authDom.forgotSubmitBtn.textContent = "Code wird angefordert...";

        try {
            const res = await window.CryptoSync.requestPasswordReset(email);
            showAuthSuccess(res.message + (res.debug_code ? ` (Test-Code: ${res.debug_code})` : ''));
            authDom.forgotPasswordForm.style.display = 'none';
            authDom.resetPasswordForm.style.display = 'flex';
            if (res.debug_code) {
                authDom.resetCode.value = res.debug_code;
            }
            authDom.resetNewPassword.focus();
        } catch (err) {
            showAuthError(err.message || "Fehler beim Anfordern des Codes.");
        } finally {
            authDom.forgotSubmitBtn.disabled = false;
            authDom.forgotSubmitBtn.textContent = "Reset-Code anfordern";
        }
    });
}

// Reset Password with Code
if (authDom.resetPasswordForm) {
    authDom.resetPasswordForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearAuthMessages();

        const email = authDom.forgotEmail.value.trim();
        const code = authDom.resetCode.value.trim();
        const newPass = authDom.resetNewPassword.value;
        const confirmPass = authDom.resetNewPasswordConfirm.value;

        if (newPass !== confirmPass) {
            showAuthError("Die Passwörter stimmen nicht überein.");
            return;
        }

        if (newPass.length < 6) {
            showAuthError("Das Passwort muss mindestens 6 Zeichen lang sein.");
            return;
        }

        authDom.resetSubmitBtn.disabled = true;
        authDom.resetSubmitBtn.textContent = "Passwort wird geändert...";

        try {
            const user = await window.CryptoSync.resetPassword(email, code, newPass);
            updateAuthUI(user);
            await loadActiveScenarioIntoApp();
            authDom.authModal.classList.remove('active');
            showToast("Passwort erfolgreich geändert! Sie sind nun angemeldet.");
        } catch (err) {
            showAuthError(err.message || "Passwort-Reset fehlgeschlagen.");
        } finally {
            authDom.resetSubmitBtn.disabled = false;
            authDom.resetSubmitBtn.textContent = "Passwort ändern & Anmelden";
        }
    });
}

// Login Handler
if (authDom.loginForm) {
    authDom.loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearAuthMessages();

        const username = authDom.loginUsername.value.trim();
        const password = authDom.loginPassword.value;

        if (!username || !password) {
            showAuthError("Bitte Benutzername/E-Mail und Passwort eingeben.");
            return;
        }

        authDom.loginSubmitBtn.disabled = true;
        authDom.loginSubmitBtn.textContent = "Wird angemeldet & entschlüsselt...";

        try {
            const user = await window.CryptoSync.login(username, password);
            updateAuthUI(user);

            await loadActiveScenarioIntoApp();

            authDom.authModal.classList.remove('active');
            authDom.loginPassword.value = '';
            showToast(`Willkommen, ${user.username}!`);
        } catch (err) {
            showAuthError(err.message || "Anmeldung fehlgeschlagen.");
        } finally {
            authDom.loginSubmitBtn.disabled = false;
            authDom.loginSubmitBtn.textContent = "Anmelden & Daten laden";
        }
    });
}

// Register Handler
if (authDom.registerForm) {
    authDom.registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearAuthMessages();

        const username = authDom.regUsername.value.trim();
        const email = authDom.regEmail ? authDom.regEmail.value.trim() : null;
        const password = authDom.regPassword.value;
        const confirm = authDom.regPasswordConfirm.value;

        if (password !== confirm) {
            showAuthError("Die Passwörter stimmen nicht überein.");
            return;
        }

        if (password.length < 6) {
            showAuthError("Das Passwort muss mindestens 6 Zeichen lang sein.");
            return;
        }

        authDom.regSubmitBtn.disabled = true;
        authDom.regSubmitBtn.textContent = "Verschlüsselung wird eingerichtet...";

        try {
            const currentXml = serializer.serializeToString(stateDoc);
            const user = await window.CryptoSync.register(username, password, email, currentXml);
            updateAuthUI(user);

            await window.CryptoSync.loadScenarios();

            authDom.authModal.classList.remove('active');
            authDom.regPassword.value = '';
            authDom.regPasswordConfirm.value = '';
            showToast(`Konto erfolgreich erstellt! Verschlüsselung aktiv.`);
        } catch (err) {
            showAuthError(err.message || "Registrierung fehlgeschlagen.");
        } finally {
            authDom.regSubmitBtn.disabled = false;
            authDom.regSubmitBtn.textContent = "Konto erstellen & Verschlüsselung aktivieren";
        }
    });
}

// Logout Handler
if (authDom.logoutBtn) {
    authDom.logoutBtn.addEventListener('click', async () => {
        if (!confirm("Möchten Sie sich wirklich abmelden?")) return;

        await window.CryptoSync.logout();
        updateAuthUI(null);

        // Bildschirm leeren / auf Ausgangszustand zurücksetzen
        stateDoc = parser.parseFromString(initialStateXML, "application/xml");
        localStorage.removeItem('ausgabenrechner_state');
        addCategoryXML("Miete");
        addCategoryXML("Lebensmittel");
        addCategoryXML("Freizeit");
        addCategoryXML("Mobilität");
        addCategoryXML("Sparen");
        render();

        showToast("Erfolgreich abgemeldet.");
    });
}

// Manual Sync Button
if (authDom.manualSyncBtn) {
    authDom.manualSyncBtn.addEventListener('click', async () => {
        const currentXml = serializer.serializeToString(stateDoc);
        const success = await window.CryptoSync.saveCloudData(currentXml);
        if (success) {
            showToast("Daten erfolgreich verschlüsselt in Cloudflare D1 gesichert.");
        } else {
            showToast("Fehler beim Synchronisieren.");
        }
    });
}

// --- Szenarien-Steuerung (UI & Interaktion) ---

function updateScenarioSelect(scenarios, activeId) {
    if (!authDom.scenarioSelect) return;
    authDom.scenarioSelect.innerHTML = '';

    scenarios.forEach(sc => {
        const opt = document.createElement('option');
        opt.value = sc.id;
        opt.textContent = sc.name;
        if (sc.id === activeId) opt.selected = true;
        authDom.scenarioSelect.appendChild(opt);
    });

    if (authDom.deleteScenarioBtn) {
        authDom.deleteScenarioBtn.disabled = (scenarios.length <= 1);
        authDom.deleteScenarioBtn.style.opacity = (scenarios.length <= 1) ? "0.5" : "1";
    }
}

// Aktives Szenario in den DOM laden & rendern
async function loadActiveScenarioIntoApp() {
    await window.CryptoSync.loadScenarios();
    const active = await window.CryptoSync.loadActiveScenario();
    if (active && active.xmlString) {
        try {
            const parsedDoc = parser.parseFromString(active.xmlString, "application/xml");
            if (parsedDoc.documentElement.nodeName !== "parsererror" && parsedDoc.documentElement.nodeName === "app") {
                stateDoc = parsedDoc;
                render();
            }
        } catch (pe) {
            console.error("Fehler beim Parsen des aktiven Szenarios:", pe);
        }
    }
}

// Szenario wechseln
if (authDom.scenarioSelect) {
    authDom.scenarioSelect.addEventListener('change', async (e) => {
        const targetId = e.target.value;
        if (!targetId || targetId === window.CryptoSync.activeScenarioId) return;

        // Vorheriges Szenario zuerst sichern
        const currentXml = serializer.serializeToString(stateDoc);
        await window.CryptoSync.saveCloudData(currentXml);

        showToast("Szenario wird gewechselt & entschlüsselt...");
        try {
            const res = await window.CryptoSync.switchScenario(targetId);
            if (res && res.xmlString) {
                const parsedDoc = parser.parseFromString(res.xmlString, "application/xml");
                if (parsedDoc.documentElement.nodeName !== "parsererror" && parsedDoc.documentElement.nodeName === "app") {
                    stateDoc = parsedDoc;
                    render();
                }
            } else {
                // Leeres Szenario
                stateDoc = parser.parseFromString(initialStateXML, "application/xml");
                addCategoryXML("Miete");
                addCategoryXML("Lebensmittel");
                addCategoryXML("Freizeit");
                addCategoryXML("Mobilität");
                addCategoryXML("Sparen");
                render();
            }
            showToast(`Szenario "${res.name}" geladen.`);
        } catch (err) {
            showToast("Fehler beim Wechseln des Szenarios: " + err.message);
        }
    });
}

// Neues Szenario Modal
if (authDom.newScenarioBtn) {
    authDom.newScenarioBtn.addEventListener('click', () => {
        authDom.newScenarioName.value = '';
        authDom.newScenarioModal.classList.add('active');
        authDom.newScenarioName.focus();
    });
}

if (authDom.closeNewScenarioModalBtn) {
    authDom.closeNewScenarioModalBtn.addEventListener('click', () => {
        authDom.newScenarioModal.classList.remove('active');
    });
}

if (authDom.cancelNewScenarioBtn) {
    authDom.cancelNewScenarioBtn.addEventListener('click', () => {
        authDom.newScenarioModal.classList.remove('active');
    });
}

if (authDom.newScenarioForm) {
    authDom.newScenarioForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = authDom.newScenarioName.value.trim();
        if (!name) return;

        const sourceRadio = authDom.newScenarioForm.querySelector('input[name="scenarioSource"]:checked');
        const isCopy = sourceRadio && sourceRadio.value === 'copy';

        let xmlToSave = '';
        if (isCopy) {
            xmlToSave = serializer.serializeToString(stateDoc);
        } else {
            const tempDoc = parser.parseFromString(initialStateXML, "application/xml");
            const catsNode = tempDoc.querySelector('categories');
            ['Miete', 'Lebensmittel', 'Freizeit', 'Mobilität', 'Sparen'].forEach(c => {
                const node = tempDoc.createElement('category');
                node.textContent = c;
                catsNode.appendChild(node);
            });
            xmlToSave = serializer.serializeToString(tempDoc);
        }

        authDom.submitNewScenarioBtn.disabled = true;
        authDom.submitNewScenarioBtn.textContent = "Erstellen...";

        try {
            const created = await window.CryptoSync.createScenario(name, xmlToSave);
            stateDoc = parser.parseFromString(xmlToSave, "application/xml");
            render();
            authDom.newScenarioModal.classList.remove('active');
            showToast(`Szenario "${created.name}" erfolgreich erstellt.`);
        } catch (err) {
            alert("Fehler beim Erstellen: " + err.message);
        } finally {
            authDom.submitNewScenarioBtn.disabled = false;
            authDom.submitNewScenarioBtn.textContent = "Erstellen";
        }
    });
}

// Szenario Umbenennen Modal
if (authDom.renameScenarioBtn) {
    authDom.renameScenarioBtn.addEventListener('click', () => {
        const currentSc = window.CryptoSync.scenarios.find(s => s.id === window.CryptoSync.activeScenarioId);
        authDom.renameScenarioInput.value = currentSc ? currentSc.name : '';
        authDom.renameScenarioModal.classList.add('active');
        authDom.renameScenarioInput.focus();
    });
}

if (authDom.closeRenameScenarioModalBtn) {
    authDom.closeRenameScenarioModalBtn.addEventListener('click', () => {
        authDom.renameScenarioModal.classList.remove('active');
    });
}

if (authDom.cancelRenameScenarioBtn) {
    authDom.cancelRenameScenarioBtn.addEventListener('click', () => {
        authDom.renameScenarioModal.classList.remove('active');
    });
}

if (authDom.renameScenarioForm) {
    authDom.renameScenarioForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newName = authDom.renameScenarioInput.value.trim();
        if (!newName) return;

        authDom.submitRenameScenarioBtn.disabled = true;
        authDom.submitRenameScenarioBtn.textContent = "Speichern...";

        try {
            await window.CryptoSync.renameScenario(window.CryptoSync.activeScenarioId, newName);
            authDom.renameScenarioModal.classList.remove('active');
            showToast(`Szenario umbenannt in "${newName}".`);
        } catch (err) {
            alert("Fehler beim Umbenennen: " + err.message);
        } finally {
            authDom.submitRenameScenarioBtn.disabled = false;
            authDom.submitRenameScenarioBtn.textContent = "Speichern";
        }
    });
}

// Szenario Löschen
if (authDom.deleteScenarioBtn) {
    authDom.deleteScenarioBtn.addEventListener('click', async () => {
        const currentSc = window.CryptoSync.scenarios.find(s => s.id === window.CryptoSync.activeScenarioId);
        const name = currentSc ? currentSc.name : 'dieses Szenario';

        if (!confirm(`Möchten Sie das Szenario "${name}" wirklich unwiderruflich löschen?`)) {
            return;
        }

        try {
            await window.CryptoSync.deleteScenario(window.CryptoSync.activeScenarioId);
            await loadActiveScenarioIntoApp();
            showToast(`Szenario "${name}" gelöscht.`);
        } catch (err) {
            alert("Löschen fehlgeschlagen: " + err.message);
        }
    });
}

// Szenarien Listener
if (window.CryptoSync) {
    window.CryptoSync.onScenariosChange((scenarios, activeId) => {
        updateScenarioSelect(scenarios, activeId);
    });

    window.CryptoSync.onStatusChange((status, lastSync, message) => {
        if (!authDom.syncStatusBadge) return;
        authDom.syncStatusBadge.className = 'badge-sync ' + status;

        if (status === 'saving') {
            authDom.syncStatusBadge.innerHTML = '🔄 Wird verschlüsselt & gespeichert...';
        } else if (status === 'pending') {
            authDom.syncStatusBadge.innerHTML = '⏳ Synchronisation ausstehend...';
        } else if (status === 'synced') {
            const timeStr = lastSync ? lastSync.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
            authDom.syncStatusBadge.innerHTML = `● Gespeichert (${timeStr} Uhr)`;
        } else if (status === 'error') {
            authDom.syncStatusBadge.innerHTML = `⚠️ Sync-Fehler (${message || 'Offline'})`;
        }
    });
}

// Initiale Sitzungsprüfung beim Laden der Seite
(async function initSession() {
    if (!window.CryptoSync) return;

    try {
        const restoredUser = await window.CryptoSync.restoreSession();
        if (restoredUser) {
            updateAuthUI(restoredUser);
            await loadActiveScenarioIntoApp();
        }
    } catch (err) {
        console.warn("Sitzung konnte nicht wiederhergestellt werden:", err);
    }
})();
