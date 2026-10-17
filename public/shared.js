// Helpers shared by the collector and CRM pages. Needs thanas.js (THANAS) loaded first.
const DIVISIONS = {
  'Barishal': ['Barguna', 'Barishal', 'Bhola', 'Jhalokati', 'Patuakhali', 'Pirojpur'],
  'Chattogram': ['Bandarban', 'Brahmanbaria', 'Chandpur', 'Chattogram', "Cox's Bazar", 'Cumilla', 'Feni', 'Khagrachhari', 'Lakshmipur', 'Noakhali', 'Rangamati'],
  'Dhaka': ['Dhaka', 'Faridpur', 'Gazipur', 'Gopalganj', 'Kishoreganj', 'Madaripur', 'Manikganj', 'Munshiganj', 'Narayanganj', 'Narsingdi', 'Rajbari', 'Shariatpur', 'Tangail'],
  'Khulna': ['Bagerhat', 'Chuadanga', 'Jashore', 'Jhenaidah', 'Khulna', 'Kushtia', 'Magura', 'Meherpur', 'Narail', 'Satkhira'],
  'Mymensingh': ['Jamalpur', 'Mymensingh', 'Netrokona', 'Sherpur'],
  'Rajshahi': ['Bogura', 'Chapainawabganj', 'Joypurhat', 'Naogaon', 'Natore', 'Pabna', 'Rajshahi', 'Sirajganj'],
  'Rangpur': ['Dinajpur', 'Gaibandha', 'Kurigram', 'Lalmonirhat', 'Nilphamari', 'Panchagarh', 'Rangpur', 'Thakurgaon'],
  'Sylhet': ['Habiganj', 'Moulvibazar', 'Sunamganj', 'Sylhet'],
};

// Fills a <select> with every district, grouped by division.
function fillDistricts(sel, emptyLabel) {
  sel.innerHTML = '';
  sel.appendChild(new Option(emptyLabel, ''));
  for (const [division, districts] of Object.entries(DIVISIONS)) {
    const group = document.createElement('optgroup');
    group.label = division + ' Division';
    districts.forEach((d) => group.appendChild(new Option(d, d)));
    sel.appendChild(group);
  }
}

function fillThanas(sel, district, emptyLabel) {
  sel.innerHTML = '';
  sel.appendChild(new Option(emptyLabel, ''));
  (THANAS[district] || []).forEach((t) => sel.appendChild(new Option(t, t)));
  sel.disabled = !district;
}

// Bangladesh numbers -> international digits (01XXXXXXXXX -> 8801XXXXXXXXX)
function waNumber(phone) {
  let d = String(phone).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = '880' + d.slice(1);
  return d;
}

// Fills {name}, {phone}, ... placeholders from `data`; unknown placeholders are left as they are.
function fillTemplate(body, data) {
  return body.replace(/\{(\w+)\}/g, (m, k) => (k in data ? data[k] ?? '' : m));
}

// Opens WhatsApp (app or web) or the SMS app with the message prefilled. Call it straight from a click handler.
function launchChannel(channel, phone, text, whatsappMode) {
  if (channel === 'sms') {
    window.location.href = `sms:+${waNumber(phone)}?body=${encodeURIComponent(text)}`;
    return;
  }
  const q = `phone=${waNumber(phone)}&text=${encodeURIComponent(text)}`;
  if (whatsappMode === 'app') window.location.href = 'whatsapp://send?' + q;
  else window.open('https://web.whatsapp.com/send?' + q, 'whatsapp_web');
}
