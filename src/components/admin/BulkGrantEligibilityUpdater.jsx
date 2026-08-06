/**
 * Admin UI for Bulk Grant Eligibility Updates
 * Allows admins to update grant descriptions, eligibility criteria, and selection criteria in bulk
 */

import React, { useState } from 'react';
import { Button, Input, Select, Table, Modal, message, Spin, Tag } from 'antd';
import { UploadOutlined, EditOutlined, CheckOutlined } from '@ant-design/icons';
import client from '@/api/client';
import './BulkGrantEligibilityUpdater.css';

const BulkGrantEligibilityUpdater = () => {
    const [grants, setGrants] = useState([]);
    const [selectedGrants, setSelectedGrants] = useState([]);
    const [loading, setLoading] = useState(false);
    const [editModal, setEditModal] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [filterCategory, setFilterCategory] = useState('all');
    const [bulkEditData, setBulkEditData] = useState({
          programDescription: '',
          eligibilitySummary: '',
          selectionCriteria: '',
    });

    // Fetch grants from API
    const fetchGrants = async () => {
          setLoading(true);
          try {
                  const data = await client.get('/api/grants?limit=1000');
if (!Array.isArray(data.grants)) {
  throw new Error('Unexpected response shape: data.grants is not an array');
}
setGrants(data.grants);
message.success(`Grants loaded successfully (${data.grants.length} records)`);
          } catch (error) {
                  message.error('Failed to load grants: ' + error.message);
          } finally {
                  setLoading(false);
          }
    };

    // Filter grants
    const filteredGrants = grants.filter(grant => {
  const title = (grant.title || '').toLowerCase();
  const funder = (grant.funder || '').toLowerCase();
  const term = searchTerm.toLowerCase();
  const matchesSearch = title.includes(term) || funder.includes(term);
  const matchesCategory =
    filterCategory === 'all' ||
    grant.category === filterCategory ||
    (filterCategory === 'missing_eligibility' && !grant.eligibility_summary);
  return matchesSearch && matchesCategory;
});

    // Apply bulk updates to selected grants
    const applyBulkUpdate = async () => {
          if (selectedGrants.length === 0) {
                  message.warning('Please select at least one grant');
                  return;
          }

          setLoading(true);
          try {
                  const updatePromises = selectedGrants.map(async (grantId) => {
  return client.put(`/api/grants/${grantId}`, {
      ...bulkEditData,
      updated_date: new Date().toISOString(),
      updated_by: localStorage.getItem('user:email')
    });
});

const results = await Promise.allSettled(updatePromises);
const failed = results.filter(r => r.status === 'rejected');
const succeeded = results.filter(r => r.status === 'fulfilled');
if (failed.length > 0) {
  console.error('[BulkGrantEligibilityUpdater] partial failure:', failed.map(f => f.reason?.message));
  message.warning(`Updated ${succeeded.length} grants; ${failed.length} failed â check console for details`);
} else {
  message.success(`Successfully updated ${succeeded.length} grants`);
}
                  setEditModal(false);
                  setSelectedGrants([]);
                  setBulkEditData({
                            programDescription: '',
                            eligibilitySummary: '',
                            selectionCriteria: '',
                  });
                  await fetchGrants();
          } catch (error) {
                  message.error('Failed to update grants: ' + error.message);
          } finally {
                  setLoading(false);
          }
    };

    const columns = [
      {
              title: 'Grant Title',
              dataIndex: 'title',
              key: 'title',
              width: '30%',
              render: (text, record) => (
                        <div className="grant-title-cell">
                                  <strong>{text}</strong>
                                  <br />
                                  <small>{record.funder}</small>
                        </div>
                      )
      },
      {
              title: 'Category',
              dataIndex: 'category',
              key: 'category',
              width: '15%',
              render: (text) => <Tag color="blue">{text || 'uncategorized'}</Tag>
                },
      {
              title: 'Eligibility Status',
              key: 'eligibility_status',
              width: '20%',
              render: (_, record) => {
                        const hasDescription = !!record.program_description;
                        const hasSummary = !!record.eligibility_summary;
                        const hasCriteria = !!record.selection_criteria;
                        const hasAppUrl = !!record.application_url;
                        
                        return (
                                    <div className="eligibility-status">
                                      {!hasAppUrl && <Tag color="volcano">No App URL</Tag>}
                                      {hasDescription && <Tag color="green"><CheckOutlined /> Description</Tag>}
                                      {hasSummary && <Tag color="green"><CheckOutlined /> Summary</Tag>}
                                      {hasCriteria && <Tag color="green"><CheckOutlined /> Criteria</Tag>}
                                      {!hasDescription && !hasSummary && !hasCriteria && (
                                                    <Tag color="red">Missing All</Tag>
                                                )}
                                    </div>
                                  );
              }
        },
      {
              title: 'Last Updated',
              dataIndex: 'updated_date',
              key: 'updated_date',
              width: '15%',
              render: (date) => date ? new Date(date).toLocaleDateString() : 'Never'
      }
        ];
  
    return (
          <div className="bulk-grant-updater">
                <div className="header">
                        <h2><EditOutlined /> Bulk Grant Eligibility Updates</h2>
                        <p>Update program descriptions, eligibility criteria, and selection criteria for multiple grants at once</p>
                </div>
          
                <div className="controls">
                        <Input.Search
                                    placeholder="Search grants by title or funder..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    style={{ marginRight: '10px', width: '300px' }}
                                  />
                        
                        <Select
                                    style={{ width: '200px', marginRight: '10px' }}
                                    value={filterCategory}
                                    onChange={setFilterCategory}
                                    options={[
                                      { label: 'All Categories', value: 'all' },
                                      { label: 'Scholarship', value: 'scholarship' },
                                      { label: 'Education', value: 'education' },
                                      { label: 'Housing', value: 'housing' },
                                      { label: 'Missing Eligibility', value: 'missing_eligibility' }
                                                ]}
                                  />
                
                        <Button type="primary" onClick={fetchGrants} loading={loading}>
                                  <UploadOutlined /> Load Grants
                        </Button>
                </div>
          
                <Spin spinning={loading}>
                        <div className="grants-table">
                                  <Table
                                                columns={columns}
                                                dataSource={filteredGrants.map(g => ({ ...g, key: g.id }))}
                                                rowSelection={{
                                                                selectedRowKeys: selectedGrants,
                                                                onChange: setSelectedGrants,
                                                }}
                                                pagination={{ pageSize: 20 }}
                                                size="small"
                                              />
                        </div>
                </Spin>
          
                <div className="actions">
                        <Button 
                                    type="primary" 
                          danger 
                                    onClick={() => setEditModal(true)}
                                    disabled={selectedGrants.length === 0}
                                  >
                                  Edit {selectedGrants.length} Selected Grants
                        </Button>
                </div>
          
                <Modal
                          title="Bulk Edit Grant Eligibility"
                          open={editModal}
                          onOk={applyBulkUpdate}
                          onCancel={() => setEditModal(false)}
                          width={800}
                          okText="Apply to Selected Grants"
                          okButtonProps={{ danger: true }}
                        >
                        <div className="bulk-edit-form">
                                  <div className="form-group">
                                              <label>Program Description</label>
                                              <textarea
                                                              value={bulkEditData.programDescription}
                                                              onChange={(e) => setBulkEditData({...bulkEditData, programDescription: e.target.value})}
                                                              placeholder="Enter program description..."
                                                              rows={3}
                                                            />
                                  </div>
                        
                                  <div className="form-group">
                                              <label>Eligibility Summary</label>
                                              <textarea
                                                              value={bulkEditData.eligibilitySummary}
                                                              onChange={(e) => setBulkEditData({...bulkEditData, eligibilitySummary: e.target.value})}
                                                              placeholder="Enter eligibility criteria summary..."
                                                              rows={4}
                                                            />
                                  </div>
                        
                                  <div className="form-group">
                                              <label>Selection Criteria</label>
                                              <textarea
                                                              value={bulkEditData.selectionCriteria}
                                                              onChange={(e) => setBulkEditData({...bulkEditData, selectionCriteria: e.target.value})}
                                                              placeholder="Enter selection criteria..."
                                                              rows={4}
                                                            />
                                  </div>
                        
                                  <div className="preview">
                                              <h4>Preview (will be applied to {selectedGrants.length} grants):</h4>
                                    {Object.entries(bulkEditData).map(([key, value]) => (
                                        value && (
                                                          <div key={key} className="preview-item">
                                                                            <strong>{key.replace(/([A-Z])/g, ' $1').trim()}:</strong>
                                                                            <p>{value}</p>
                                                          </div>
                                                        )
                                      ))}
                                  </div>
                        </div>
                </Modal>
          </div>
        );
};

export default BulkGrantEligibilityUpdater;
