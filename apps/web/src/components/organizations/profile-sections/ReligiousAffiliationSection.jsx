import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Edit, X, Save } from 'lucide-react';
import ParseFromDocsButton from '@/components/shared/ParseFromDocsButton';

// Flattened fields for parsing
const RELIGION_FIELDS = [
  { field: 'religious_affiliation_christian', label: 'Christian', type: 'boolean' },
  { field: 'religious_affiliation_catholic', label: 'Catholic', type: 'boolean' },
  { field: 'religious_affiliation_baptist', label: 'Baptist', type: 'boolean' },
  { field: 'religious_affiliation_pentecostal', label: 'Pentecostal', type: 'boolean' },
  { field: 'religious_affiliation_methodist', label: 'Methodist', type: 'boolean' },
  { field: 'religious_affiliation_lutheran', label: 'Lutheran', type: 'boolean' },
  { field: 'religious_affiliation_presbyterian', label: 'Presbyterian', type: 'boolean' },
  { field: 'religious_affiliation_nondenominational', label: 'Non-Denominational', type: 'boolean' },
  { field: 'religious_affiliation_jewish', label: 'Jewish', type: 'boolean' },
  { field: 'religious_affiliation_muslim', label: 'Muslim', type: 'boolean' },
  { field: 'religious_affiliation_buddhist', label: 'Buddhist', type: 'boolean' },
  { field: 'religious_affiliation_hindu', label: 'Hindu', type: 'boolean' },
  { field: 'religious_affiliation_sikh', label: 'Sikh', type: 'boolean' },
  { field: 'religious_affiliation_other', label: 'Other Religious Affiliation', type: 'string' },
];

/**
 * ReligiousAffiliationSection - Extracted from OrganizationProfileDetails
 * Handles all 100+ religious denomination checkboxes
 * Optimized with grouped rendering
 */

const RELIGION_GROUPS = [
  {
    title: 'Christianity',
    fields: [
      { id: 'religious_affiliation_christian', label: 'Christian (General)' }
    ]
  },
  {
    title: 'Catholic',
    fields: [
      { id: 'religious_affiliation_catholic', label: 'Catholic (General)' },
      { id: 'religious_affiliation_roman_catholic', label: 'Roman Catholic' },
      { id: 'religious_affiliation_eastern_catholic', label: 'Eastern Catholic' }
    ]
  },
  {
    title: 'Orthodox Christian',
    fields: [
      { id: 'religious_affiliation_orthodox', label: 'Orthodox (General)' },
      { id: 'religious_affiliation_greek_orthodox', label: 'Greek Orthodox' },
      { id: 'religious_affiliation_russian_orthodox', label: 'Russian Orthodox' },
      { id: 'religious_affiliation_antiochian_orthodox', label: 'Antiochian Orthodox' },
      { id: 'religious_affiliation_coptic_orthodox', label: 'Coptic Orthodox' },
      { id: 'religious_affiliation_ethiopian_orthodox', label: 'Ethiopian Orthodox' }
    ]
  },
  {
    title: 'Baptist',
    fields: [
      { id: 'religious_affiliation_baptist', label: 'Baptist (General)' },
      { id: 'religious_affiliation_southern_baptist', label: 'Southern Baptist' },
      { id: 'religious_affiliation_freewill_baptist', label: 'Freewill Baptist' },
      { id: 'religious_affiliation_independent_baptist', label: 'Independent Baptist' },
      { id: 'religious_affiliation_missionary_baptist', label: 'Missionary Baptist' },
      { id: 'religious_affiliation_primitive_baptist', label: 'Primitive Baptist' },
      { id: 'religious_affiliation_american_baptist', label: 'American Baptist' },
      { id: 'religious_affiliation_national_baptist', label: 'National Baptist' },
      { id: 'religious_affiliation_reformed_baptist', label: 'Reformed Baptist' }
    ]
  },
  {
    title: 'Pentecostal / Charismatic',
    fields: [
      { id: 'religious_affiliation_pentecostal', label: 'Pentecostal (General)' },
      { id: 'religious_affiliation_church_of_god', label: 'Church of God (Cleveland, TN)' },
      { id: 'religious_affiliation_cogop', label: 'Church of God of Prophecy' },
      { id: 'religious_affiliation_assemblies_of_god', label: 'Assemblies of God' },
      { id: 'religious_affiliation_foursquare', label: 'Foursquare Church' },
      { id: 'religious_affiliation_apostolic', label: 'Apostolic / Oneness Pentecostal' },
      { id: 'religious_affiliation_upci', label: 'United Pentecostal Church Intl' },
      { id: 'religious_affiliation_cogic', label: 'Church of God in Christ (COGIC)' },
      { id: 'religious_affiliation_charismatic', label: 'Charismatic (Non-Denominational)' },
      { id: 'religious_affiliation_vineyard', label: 'Vineyard' }
    ]
  },
  {
    title: 'Methodist / Wesleyan',
    fields: [
      { id: 'religious_affiliation_methodist', label: 'Methodist (General)' },
      { id: 'religious_affiliation_united_methodist', label: 'United Methodist' },
      { id: 'religious_affiliation_global_methodist', label: 'Global Methodist' },
      { id: 'religious_affiliation_free_methodist', label: 'Free Methodist' },
      { id: 'religious_affiliation_wesleyan', label: 'Wesleyan Church' },
      { id: 'religious_affiliation_ame', label: 'African Methodist Episcopal (AME)' },
      { id: 'religious_affiliation_ame_zion', label: 'AME Zion' },
      { id: 'religious_affiliation_cme', label: 'Christian Methodist Episcopal (CME)' },
      { id: 'religious_affiliation_nazarene', label: 'Church of the Nazarene' },
      { id: 'religious_affiliation_salvation_army', label: 'Salvation Army' }
    ]
  },
  {
    title: 'Lutheran',
    fields: [
      { id: 'religious_affiliation_lutheran', label: 'Lutheran (General)' },
      { id: 'religious_affiliation_elca', label: 'ELCA (Evangelical Lutheran)' },
      { id: 'religious_affiliation_lcms', label: 'LCMS (Missouri Synod)' },
      { id: 'religious_affiliation_wels', label: 'WELS (Wisconsin Synod)' }
    ]
  },
  {
    title: 'Presbyterian / Reformed',
    fields: [
      { id: 'religious_affiliation_presbyterian', label: 'Presbyterian (General)' },
      { id: 'religious_affiliation_pcusa', label: 'PC(USA)' },
      { id: 'religious_affiliation_pca', label: 'PCA (Presbyterian Church in America)' },
      { id: 'religious_affiliation_epc', label: 'EPC (Evangelical Presbyterian)' },
      { id: 'religious_affiliation_reformed', label: 'Reformed Church' },
      { id: 'religious_affiliation_crc', label: 'Christian Reformed Church' }
    ]
  },
  {
    title: 'Other Protestant / Evangelical',
    fields: [
      { id: 'religious_affiliation_protestant', label: 'Protestant (General)' },
      { id: 'religious_affiliation_evangelical', label: 'Evangelical (Non-Denom)' },
      { id: 'religious_affiliation_nondenominational', label: 'Non-Denominational' },
      { id: 'religious_affiliation_disciples_of_christ', label: 'Disciples of Christ' },
      { id: 'religious_affiliation_church_of_christ', label: 'Church of Christ' },
      { id: 'religious_affiliation_episcopal', label: 'Episcopal / Anglican' },
      { id: 'religious_affiliation_congregational', label: 'Congregational / UCC' },
      { id: 'religious_affiliation_christian_missionary_alliance', label: 'Christian & Missionary Alliance' },
      { id: 'religious_affiliation_covenant', label: 'Evangelical Covenant' },
      { id: 'religious_affiliation_brethren', label: 'Brethren' }
    ]
  },
  {
    title: 'Anabaptist',
    fields: [
      { id: 'religious_affiliation_amish', label: 'Amish' },
      { id: 'religious_affiliation_mennonite', label: 'Mennonite' },
      { id: 'religious_affiliation_hutterite', label: 'Hutterite' },
      { id: 'religious_affiliation_brethren_in_christ', label: 'Brethren in Christ' }
    ]
  },
  {
    title: 'Other Christian Traditions',
    fields: [
      { id: 'religious_affiliation_quaker', label: 'Quaker / Friends' },
      { id: 'religious_affiliation_seventh_day_adventist', label: 'Seventh-day Adventist' },
      { id: 'religious_affiliation_latter_day_saints', label: 'Latter-day Saints (LDS/Mormon)' },
      { id: 'religious_affiliation_jehovahs_witness', label: "Jehovah's Witness" },
      { id: 'religious_affiliation_unity', label: 'Unity Church' },
      { id: 'religious_affiliation_christian_science', label: 'Christian Science' }
    ]
  },
  {
    title: 'Judaism',
    fields: [
      { id: 'religious_affiliation_jewish', label: 'Jewish (General)' },
      { id: 'religious_affiliation_reform_jewish', label: 'Reform Judaism' },
      { id: 'religious_affiliation_conservative_jewish', label: 'Conservative Judaism' },
      { id: 'religious_affiliation_orthodox_jewish', label: 'Orthodox Judaism' },
      { id: 'religious_affiliation_hasidic', label: 'Hasidic' },
      { id: 'religious_affiliation_reconstructionist', label: 'Reconstructionist' },
      { id: 'religious_affiliation_messianic_jewish', label: 'Messianic Jewish' }
    ]
  },
  {
    title: 'Islam',
    fields: [
      { id: 'religious_affiliation_muslim', label: 'Muslim (General)' },
      { id: 'religious_affiliation_sunni', label: 'Sunni' },
      { id: 'religious_affiliation_shia', label: 'Shia' },
      { id: 'religious_affiliation_sufi', label: 'Sufi' },
      { id: 'religious_affiliation_nation_of_islam', label: 'Nation of Islam' },
      { id: 'religious_affiliation_ahmadiyya', label: 'Ahmadiyya' }
    ]
  },
  {
    title: 'Buddhism',
    fields: [
      { id: 'religious_affiliation_buddhist', label: 'Buddhist (General)' },
      { id: 'religious_affiliation_zen', label: 'Zen Buddhism' },
      { id: 'religious_affiliation_tibetan_buddhist', label: 'Tibetan Buddhism' },
      { id: 'religious_affiliation_theravada', label: 'Theravada Buddhism' },
      { id: 'religious_affiliation_mahayana', label: 'Mahayana Buddhism' },
      { id: 'religious_affiliation_pure_land', label: 'Pure Land Buddhism' }
    ]
  },
  {
    title: 'Hinduism',
    fields: [
      { id: 'religious_affiliation_hindu', label: 'Hindu (General)' },
      { id: 'religious_affiliation_vaishnava', label: 'Vaishnava' },
      { id: 'religious_affiliation_shaiva', label: 'Shaiva' },
      { id: 'religious_affiliation_shakta', label: 'Shakta' },
      { id: 'religious_affiliation_hare_krishna', label: 'ISKCON / Hare Krishna' }
    ]
  },
  {
    title: 'Other Religions & Spirituality',
    fields: [
      { id: 'religious_affiliation_sikh', label: 'Sikh' },
      { id: 'religious_affiliation_bahai', label: "Bahá'í" },
      { id: 'religious_affiliation_jain', label: 'Jain' },
      { id: 'religious_affiliation_zoroastrian', label: 'Zoroastrian' },
      { id: 'religious_affiliation_shinto', label: 'Shinto' },
      { id: 'religious_affiliation_taoist', label: 'Taoist' },
      { id: 'religious_affiliation_confucian', label: 'Confucian' },
      { id: 'religious_affiliation_unitarian', label: 'Unitarian Universalist' },
      { id: 'religious_affiliation_wiccan', label: 'Wiccan / Pagan' },
      { id: 'religious_affiliation_native_american_spirituality', label: 'Native American Spirituality' },
      { id: 'religious_affiliation_spiritual_not_religious', label: 'Spiritual but Not Religious' },
      { id: 'religious_affiliation_agnostic', label: 'Agnostic' },
      { id: 'religious_affiliation_atheist', label: 'Atheist' }
    ]
  }
];

const ReligiousCheckboxGroup = React.memo(({ group, currentData, handleFieldUpdate }) => (
  <div>
    <h4 className="text-sm font-semibold text-violet-800 mb-2 border-b pb-1">{group.title}</h4>
    <div className="grid grid-cols-2 gap-2">
      {group.fields.map(item => (
        <div key={item.id} className="flex items-center space-x-2">
          <Checkbox 
            id={item.id} 
            checked={currentData[item.id] || false} 
            onCheckedChange={(checked) => handleFieldUpdate(item.id, checked)} 
          />
          <Label htmlFor={item.id} className="text-sm">{item.label}</Label>
        </div>
      ))}
    </div>
  </div>
));

const ReligiousBadgeDisplay = React.memo(({ organization }) => {
  const safeOrg = organization || {};
  const activeDenominations = React.useMemo(() => {
    return Object.keys(safeOrg).filter(key => 
      key.startsWith('religious_affiliation_') && 
      key !== 'religious_affiliation_other' && 
      safeOrg[key] === true
    );
  }, [safeOrg]);

  if (activeDenominations.length === 0 && !safeOrg.religious_affiliation_other) {
    return <p className="text-sm text-slate-500 italic">No religious affiliation recorded. Click edit to add.</p>;
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {safeOrg.religious_affiliation_christian && <Badge className="bg-violet-100 text-violet-800">Christian</Badge>}
        {safeOrg.religious_affiliation_catholic && <Badge className="bg-violet-100 text-violet-800">Catholic</Badge>}
        {safeOrg.religious_affiliation_roman_catholic && <Badge className="bg-violet-100 text-violet-800">Roman Catholic</Badge>}
        {safeOrg.religious_affiliation_eastern_catholic && <Badge className="bg-violet-100 text-violet-800">Eastern Catholic</Badge>}
        {safeOrg.religious_affiliation_orthodox && <Badge className="bg-violet-100 text-violet-800">Orthodox Christian</Badge>}
        {safeOrg.religious_affiliation_greek_orthodox && <Badge className="bg-violet-100 text-violet-800">Greek Orthodox</Badge>}
        {safeOrg.religious_affiliation_russian_orthodox && <Badge className="bg-violet-100 text-violet-800">Russian Orthodox</Badge>}
        {safeOrg.religious_affiliation_antiochian_orthodox && <Badge className="bg-violet-100 text-violet-800">Antiochian Orthodox</Badge>}
        {safeOrg.religious_affiliation_coptic_orthodox && <Badge className="bg-violet-100 text-violet-800">Coptic Orthodox</Badge>}
        {safeOrg.religious_affiliation_ethiopian_orthodox && <Badge className="bg-violet-100 text-violet-800">Ethiopian Orthodox</Badge>}
        {safeOrg.religious_affiliation_baptist && <Badge className="bg-violet-100 text-violet-800">Baptist</Badge>}
        {safeOrg.religious_affiliation_southern_baptist && <Badge className="bg-violet-100 text-violet-800">Southern Baptist</Badge>}
        {safeOrg.religious_affiliation_freewill_baptist && <Badge className="bg-violet-100 text-violet-800">Freewill Baptist</Badge>}
        {safeOrg.religious_affiliation_independent_baptist && <Badge className="bg-violet-100 text-violet-800">Independent Baptist</Badge>}
        {safeOrg.religious_affiliation_missionary_baptist && <Badge className="bg-violet-100 text-violet-800">Missionary Baptist</Badge>}
        {safeOrg.religious_affiliation_primitive_baptist && <Badge className="bg-violet-100 text-violet-800">Primitive Baptist</Badge>}
        {safeOrg.religious_affiliation_american_baptist && <Badge className="bg-violet-100 text-violet-800">American Baptist</Badge>}
        {safeOrg.religious_affiliation_national_baptist && <Badge className="bg-violet-100 text-violet-800">National Baptist</Badge>}
        {safeOrg.religious_affiliation_reformed_baptist && <Badge className="bg-violet-100 text-violet-800">Reformed Baptist</Badge>}
        {safeOrg.religious_affiliation_pentecostal && <Badge className="bg-violet-100 text-violet-800">Pentecostal</Badge>}
        {safeOrg.religious_affiliation_church_of_god && <Badge className="bg-violet-100 text-violet-800">Church of God</Badge>}
        {safeOrg.religious_affiliation_cogop && <Badge className="bg-violet-100 text-violet-800">Church of God of Prophecy</Badge>}
        {safeOrg.religious_affiliation_assemblies_of_god && <Badge className="bg-violet-100 text-violet-800">Assemblies of God</Badge>}
        {safeOrg.religious_affiliation_foursquare && <Badge className="bg-violet-100 text-violet-800">Foursquare</Badge>}
        {safeOrg.religious_affiliation_apostolic && <Badge className="bg-violet-100 text-violet-800">Apostolic</Badge>}
        {safeOrg.religious_affiliation_upci && <Badge className="bg-violet-100 text-violet-800">United Pentecostal</Badge>}
        {safeOrg.religious_affiliation_cogic && <Badge className="bg-violet-100 text-violet-800">COGIC</Badge>}
        {safeOrg.religious_affiliation_charismatic && <Badge className="bg-violet-100 text-violet-800">Charismatic</Badge>}
        {safeOrg.religious_affiliation_vineyard && <Badge className="bg-violet-100 text-violet-800">Vineyard</Badge>}
        {safeOrg.religious_affiliation_methodist && <Badge className="bg-violet-100 text-violet-800">Methodist</Badge>}
        {safeOrg.religious_affiliation_united_methodist && <Badge className="bg-violet-100 text-violet-800">United Methodist</Badge>}
        {safeOrg.religious_affiliation_global_methodist && <Badge className="bg-violet-100 text-violet-800">Global Methodist</Badge>}
        {safeOrg.religious_affiliation_free_methodist && <Badge className="bg-violet-100 text-violet-800">Free Methodist</Badge>}
        {safeOrg.religious_affiliation_wesleyan && <Badge className="bg-violet-100 text-violet-800">Wesleyan</Badge>}
        {safeOrg.religious_affiliation_ame && <Badge className="bg-violet-100 text-violet-800">AME</Badge>}
        {safeOrg.religious_affiliation_ame_zion && <Badge className="bg-violet-100 text-violet-800">AME Zion</Badge>}
        {safeOrg.religious_affiliation_cme && <Badge className="bg-violet-100 text-violet-800">CME</Badge>}
        {safeOrg.religious_affiliation_nazarene && <Badge className="bg-violet-100 text-violet-800">Nazarene</Badge>}
        {safeOrg.religious_affiliation_salvation_army && <Badge className="bg-violet-100 text-violet-800">Salvation Army</Badge>}
        {safeOrg.religious_affiliation_lutheran && <Badge className="bg-violet-100 text-violet-800">Lutheran</Badge>}
        {safeOrg.religious_affiliation_elca && <Badge className="bg-violet-100 text-violet-800">ELCA</Badge>}
        {safeOrg.religious_affiliation_lcms && <Badge className="bg-violet-100 text-violet-800">LCMS</Badge>}
        {safeOrg.religious_affiliation_wels && <Badge className="bg-violet-100 text-violet-800">WELS</Badge>}
        {safeOrg.religious_affiliation_presbyterian && <Badge className="bg-violet-100 text-violet-800">Presbyterian</Badge>}
        {safeOrg.religious_affiliation_pcusa && <Badge className="bg-violet-100 text-violet-800">PC(USA)</Badge>}
        {safeOrg.religious_affiliation_pca && <Badge className="bg-violet-100 text-violet-800">PCA</Badge>}
        {safeOrg.religious_affiliation_epc && <Badge className="bg-violet-100 text-violet-800">EPC</Badge>}
        {safeOrg.religious_affiliation_reformed && <Badge className="bg-violet-100 text-violet-800">Reformed</Badge>}
        {safeOrg.religious_affiliation_crc && <Badge className="bg-violet-100 text-violet-800">Christian Reformed</Badge>}
        {safeOrg.religious_affiliation_protestant && <Badge className="bg-violet-100 text-violet-800">Protestant</Badge>}
        {safeOrg.religious_affiliation_evangelical && <Badge className="bg-violet-100 text-violet-800">Evangelical</Badge>}
        {safeOrg.religious_affiliation_nondenominational && <Badge className="bg-violet-100 text-violet-800">Non-Denominational</Badge>}
        {safeOrg.religious_affiliation_disciples_of_christ && <Badge className="bg-violet-100 text-violet-800">Disciples of Christ</Badge>}
        {safeOrg.religious_affiliation_church_of_christ && <Badge className="bg-violet-100 text-violet-800">Church of Christ</Badge>}
        {safeOrg.religious_affiliation_episcopal && <Badge className="bg-violet-100 text-violet-800">Episcopal</Badge>}
        {safeOrg.religious_affiliation_congregational && <Badge className="bg-violet-100 text-violet-800">Congregational/UCC</Badge>}
        {safeOrg.religious_affiliation_christian_missionary_alliance && <Badge className="bg-violet-100 text-violet-800">C&MA</Badge>}
        {safeOrg.religious_affiliation_covenant && <Badge className="bg-violet-100 text-violet-800">Covenant</Badge>}
        {safeOrg.religious_affiliation_brethren && <Badge className="bg-violet-100 text-violet-800">Brethren</Badge>}
        {safeOrg.religious_affiliation_amish && <Badge className="bg-violet-100 text-violet-800">Amish</Badge>}
        {safeOrg.religious_affiliation_mennonite && <Badge className="bg-violet-100 text-violet-800">Mennonite</Badge>}
        {safeOrg.religious_affiliation_hutterite && <Badge className="bg-violet-100 text-violet-800">Hutterite</Badge>}
        {safeOrg.religious_affiliation_brethren_in_christ && <Badge className="bg-violet-100 text-violet-800">Brethren in Christ</Badge>}
        {safeOrg.religious_affiliation_quaker && <Badge className="bg-violet-100 text-violet-800">Quaker</Badge>}
        {safeOrg.religious_affiliation_seventh_day_adventist && <Badge className="bg-violet-100 text-violet-800">Seventh-day Adventist</Badge>}
        {safeOrg.religious_affiliation_latter_day_saints && <Badge className="bg-violet-100 text-violet-800">Latter-day Saints</Badge>}
        {safeOrg.religious_affiliation_jehovahs_witness && <Badge className="bg-violet-100 text-violet-800">Jehovah's Witness</Badge>}
        {safeOrg.religious_affiliation_unity && <Badge className="bg-violet-100 text-violet-800">Unity Church</Badge>}
        {safeOrg.religious_affiliation_christian_science && <Badge className="bg-violet-100 text-violet-800">Christian Science</Badge>}
        {safeOrg.religious_affiliation_jewish && <Badge className="bg-violet-100 text-violet-800">Jewish</Badge>}
        {safeOrg.religious_affiliation_reform_jewish && <Badge className="bg-violet-100 text-violet-800">Reform Jewish</Badge>}
        {safeOrg.religious_affiliation_conservative_jewish && <Badge className="bg-violet-100 text-violet-800">Conservative Jewish</Badge>}
        {safeOrg.religious_affiliation_orthodox_jewish && <Badge className="bg-violet-100 text-violet-800">Orthodox Jewish</Badge>}
        {safeOrg.religious_affiliation_hasidic && <Badge className="bg-violet-100 text-violet-800">Hasidic</Badge>}
        {safeOrg.religious_affiliation_reconstructionist && <Badge className="bg-violet-100 text-violet-800">Reconstructionist</Badge>}
        {safeOrg.religious_affiliation_messianic_jewish && <Badge className="bg-violet-100 text-violet-800">Messianic Jewish</Badge>}
        {safeOrg.religious_affiliation_muslim && <Badge className="bg-violet-100 text-violet-800">Muslim</Badge>}
        {safeOrg.religious_affiliation_sunni && <Badge className="bg-violet-100 text-violet-800">Sunni</Badge>}
        {safeOrg.religious_affiliation_shia && <Badge className="bg-violet-100 text-violet-800">Shia</Badge>}
        {safeOrg.religious_affiliation_sufi && <Badge className="bg-violet-100 text-violet-800">Sufi</Badge>}
        {safeOrg.religious_affiliation_nation_of_islam && <Badge className="bg-violet-100 text-violet-800">Nation of Islam</Badge>}
        {safeOrg.religious_affiliation_ahmadiyya && <Badge className="bg-violet-100 text-violet-800">Ahmadiyya</Badge>}
        {safeOrg.religious_affiliation_buddhist && <Badge className="bg-violet-100 text-violet-800">Buddhist</Badge>}
        {safeOrg.religious_affiliation_zen && <Badge className="bg-violet-100 text-violet-800">Zen Buddhist</Badge>}
        {safeOrg.religious_affiliation_tibetan_buddhist && <Badge className="bg-violet-100 text-violet-800">Tibetan Buddhist</Badge>}
        {safeOrg.religious_affiliation_theravada && <Badge className="bg-violet-100 text-violet-800">Theravada</Badge>}
        {safeOrg.religious_affiliation_mahayana && <Badge className="bg-violet-100 text-violet-800">Mahayana</Badge>}
        {safeOrg.religious_affiliation_pure_land && <Badge className="bg-violet-100 text-violet-800">Pure Land</Badge>}
        {safeOrg.religious_affiliation_hindu && <Badge className="bg-violet-100 text-violet-800">Hindu</Badge>}
        {safeOrg.religious_affiliation_vaishnava && <Badge className="bg-violet-100 text-violet-800">Vaishnava</Badge>}
        {safeOrg.religious_affiliation_shaiva && <Badge className="bg-violet-100 text-violet-800">Shaiva</Badge>}
        {safeOrg.religious_affiliation_shakta && <Badge className="bg-violet-100 text-violet-800">Shakta</Badge>}
        {safeOrg.religious_affiliation_hare_krishna && <Badge className="bg-violet-100 text-violet-800">Hare Krishna</Badge>}
        {safeOrg.religious_affiliation_sikh && <Badge className="bg-violet-100 text-violet-800">Sikh</Badge>}
        {safeOrg.religious_affiliation_bahai && <Badge className="bg-violet-100 text-violet-800">Bahá'í</Badge>}
        {safeOrg.religious_affiliation_jain && <Badge className="bg-violet-100 text-violet-800">Jain</Badge>}
        {safeOrg.religious_affiliation_zoroastrian && <Badge className="bg-violet-100 text-violet-800">Zoroastrian</Badge>}
        {safeOrg.religious_affiliation_shinto && <Badge className="bg-violet-100 text-violet-800">Shinto</Badge>}
        {safeOrg.religious_affiliation_taoist && <Badge className="bg-violet-100 text-violet-800">Taoist</Badge>}
        {safeOrg.religious_affiliation_confucian && <Badge className="bg-violet-100 text-violet-800">Confucian</Badge>}
        {safeOrg.religious_affiliation_unitarian && <Badge className="bg-violet-100 text-violet-800">Unitarian Universalist</Badge>}
        {safeOrg.religious_affiliation_wiccan && <Badge className="bg-violet-100 text-violet-800">Wiccan/Pagan</Badge>}
        {safeOrg.religious_affiliation_native_american_spirituality && <Badge className="bg-violet-100 text-violet-800">Native American Spirituality</Badge>}
        {safeOrg.religious_affiliation_spiritual_not_religious && <Badge className="bg-violet-100 text-violet-800">Spiritual but Not Religious</Badge>}
        {safeOrg.religious_affiliation_agnostic && <Badge className="bg-violet-100 text-violet-800">Agnostic</Badge>}
        {safeOrg.religious_affiliation_atheist && <Badge className="bg-violet-100 text-violet-800">Atheist</Badge>}
      </div>
      {safeOrg.religious_affiliation_other && (
        <div className="mt-3 pt-3 border-t">
          <div className="text-sm font-medium text-slate-700 mb-1">Other Religious Affiliation</div>
          <div className="text-slate-600">{safeOrg.religious_affiliation_other}</div>
        </div>
      )}
    </>
  );
});

export default function ReligiousAffiliationSection({ 
  organization, 
  isEditing, 
  tempData, 
  onStartEdit, 
  onCancelEdit, 
  onSave, 
  onUpdateField,
  onUpdateTemp,
  onUpdate,
  isUpdating 
}) {
  const safeOrg = organization || {};
  const currentData = isEditing ? (tempData || {}) : safeOrg;

  const handleFieldUpdate = (field, value) => {
    if (typeof onUpdateField === 'function') {
      onUpdateField(field, value);
    } else if (typeof onUpdateTemp === 'function') {
      onUpdateTemp(field, value);
    } else {
      console.warn('[ReligiousAffiliationSection] No update handler provided');
    }
  };

  // Wrap onUpdate to ensure it works correctly with ParseFromDocsButton
  const handleParsedUpdate = ({ id, data }) => {
    console.log('[ReligiousAffiliationSection] handleParsedUpdate called:', { id, data });
    if (onUpdate && id && data) {
      onUpdate({ id, data });
    }
  };

  return (
    <Card className="border-violet-200">
      <CardHeader className="bg-violet-50 flex flex-row items-center justify-between">
        <CardTitle className="text-violet-900">Religious Affiliation</CardTitle>
        <div className="flex gap-2">
          <ParseFromDocsButton
            organizationId={safeOrg.id}
            sectionName="Religious Affiliation"
            fieldsToExtract={RELIGION_FIELDS}
            onUpdate={handleParsedUpdate}
            disabled={isUpdating || isEditing || !safeOrg.id}
          />
          {!isEditing ? (
            <Button variant="ghost" size="sm" onClick={onStartEdit} disabled={isUpdating}>
              <Edit className="w-4 h-4" />
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={onCancelEdit} disabled={isUpdating}>
                <X className="w-4 h-4" />
              </Button>
              <Button variant="default" size="sm" onClick={onSave} disabled={isUpdating}>
                <Save className="w-4 h-4" />
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-4">
        {isEditing ? (
          <div className="space-y-6">
            {RELIGION_GROUPS.map(group => (
              <ReligiousCheckboxGroup
                key={group.title}
                group={group}
                currentData={currentData}
                handleFieldUpdate={handleFieldUpdate}
              />
            ))}
            <div className="p-3 bg-violet-50 rounded">
              <Label htmlFor="religious_affiliation_other_edit" className="text-sm font-medium">Other Religious Affiliation</Label>
              <Input
                id="religious_affiliation_other_edit"
                value={currentData.religious_affiliation_other || ''}
                onChange={(e) => handleFieldUpdate('religious_affiliation_other', e.target.value)}
                placeholder="Specify other religious affiliation"
                className="mt-1"
              />
            </div>
          </div>
        ) : (
          <ReligiousBadgeDisplay organization={safeOrg} />
        )}
      </CardContent>
    </Card>
  );
}